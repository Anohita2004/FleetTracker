const cds = require("@sap/cds");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const session = require("express-session");
const { SELECT, INSERT, UPDATE } = cds.ql;
const { createSecurityContext, XsuaaService, XsaService } = require("@sap/xssec");

module.exports = cds.server;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const nowISO = () => new Date().toISOString();
const PASSWORD_MIN_LENGTH = 8;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessionSecret = process.env.JWT_SECRET_KEY || process.env.SESSION_SECRET || "location-tracker-driver-session-secret";
const hashToken = (value) => crypto.createHash("sha256").update(String(value || "")).digest("hex");
const getSessionTokenHash = (req) => hashToken(`${req.sessionID}:${sessionSecret}`);
const isFutureDate = (value) => value && new Date(value).getTime() > Date.now();
const roundToTwoDecimals = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

// Lazily built auth service – created once from XSUAA credentials on first request
let _authService = null;
const getAuthService = () => {
  if (_authService) return _authService;
  const { credentials, config: serviceConfig = {} } = cds.requires.auth || {};
  if (!credentials) return null;
  _authService = credentials.uaadomain
    ? new XsuaaService(credentials, serviceConfig)
    : new XsaService(credentials, serviceConfig);
  return _authService;
};

cds.on("bootstrap", (app) => {
  app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS
    }
  }));

  const dbPromise = cds.connect.to("db");
  const driverSelectFields = ["ID", "name", "email", "phone", "status", "admin_ID", "temporaryPassword"];

  const getDriverByEmail = async (db, email) => {
    return db.run(SELECT.one.from("tracker.Drivers").where({ email: normalizeEmail(email) }));
  };

  const getDriverById = async (db, driverId) => {
    return db.run(SELECT.one.from("tracker.Drivers").columns(...driverSelectFields).where({ ID: driverId }));
  };

  const getTripById = async (db, tripId) => {
    return db.run(SELECT.one.from("tracker.Trips").where({ ID: tripId }));
  };

  const getActiveTrip = async (db, driverId) => {
    return db.run(
      SELECT.one.from("tracker.Trips")
        .where({ status: "ACTIVE", driver_ID: driverId })
        .orderBy("startedAt desc")
    );
  };

  const requireDriverSession = async (req, res, next) => {
    try {
      const driverId = req.session?.driverId;
      if (!driverId || !req.sessionID) {
        return res.status(401).json({ error: "Driver login required" });
      }

      const db = await dbPromise;
      const sessionTokenHash = getSessionTokenHash(req);
      const activeSession = await db.run(
        SELECT.one.from("tracker.DriverSessions")
          .where({ driver_ID: driverId, sessionTokenHash, revoked: false })
      );

      if (!activeSession || !isFutureDate(activeSession.expiresAt)) {
        return res.status(401).json({ error: "Driver session expired. Please log in again." });
      }

      const driver = await getDriverById(db, driverId);
      if (!driver || driver.status !== "ACTIVE") {
        return res.status(403).json({ error: "No active driver profile is assigned to this login" });
      }

      await db.run(
        UPDATE("tracker.DriverSessions")
          .set({ lastAccessedAt: nowISO() })
          .where({ ID: activeSession.ID })
      );

      req.driver = driver;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  app.post("/drivers/login", async (req, res, next) => {
    try {
      const email = normalizeEmail(req.body?.email);
      const password = String(req.body?.password || "");

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }
      if (password.length < PASSWORD_MIN_LENGTH) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }

      const db = await dbPromise;
      const driver = await getDriverByEmail(db, email);
      if (!driver || driver.status !== "ACTIVE" || !driver.passwordHash) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const passwordOk = await bcrypt.compare(password, driver.passwordHash);
      if (!passwordOk) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      await new Promise((resolve, reject) => {
        req.session.regenerate((error) => (error ? reject(error) : resolve()));
      });

      req.session.driverId = driver.ID;
      req.session.driverEmail = driver.email;
      req.session.loggedInAt = nowISO();

      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      const sessionTokenHash = getSessionTokenHash(req);

      await db.run(
        INSERT.into("tracker.DriverSessions").entries({
          ID: cds.utils.uuid(),
          driver_ID: driver.ID,
          sessionTokenHash,
          expiresAt,
          lastAccessedAt: nowISO(),
          revoked: false
        })
      );

      return res.json({
        driver: {
          ID: driver.ID,
          name: driver.name,
          email: driver.email,
          status: driver.status
        }
      });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/logout", requireDriverSession, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const sessionTokenHash = getSessionTokenHash(req);
      await db.run(
        UPDATE("tracker.DriverSessions")
          .set({ revoked: true, lastAccessedAt: nowISO() })
          .where({ driver_ID: req.driver.ID, sessionTokenHash, revoked: false })
      );

      await new Promise((resolve, reject) => {
        req.session.destroy((error) => (error ? reject(error) : resolve()));
      });

      res.clearCookie("connect.sid");
      return res.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/me", requireDriverSession, async (req, res) => {
    res.json({ driver: req.driver });
  });

  app.get("/drivers/activeTrip", requireDriverSession, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const trip = await getActiveTrip(db, req.driver.ID);
      return res.json(trip || null);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/startTrip", requireDriverSession, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const activeTrip = await getActiveTrip(db, req.driver.ID);
      if (activeTrip) {
        return res.json(activeTrip);
      }

      const entry = {
        ID: cds.utils.uuid(),
        title: req.body?.title || `Trip ${nowISO()}`,
        driver_ID: req.driver.ID,
        startedAt: nowISO(),
        status: "ACTIVE"
      };

      await db.run(INSERT.into("tracker.Trips").entries(entry));
      return res.json(entry);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/stopTrip", requireDriverSession, async (req, res, next) => {
    try {
      const tripId = req.body?.tripId;
      if (!tripId) {
        return res.status(400).json({ error: "tripId is required" });
      }

      const db = await dbPromise;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }

      await db.run(
        UPDATE("tracker.Trips")
          .set({ status: "COMPLETED", endedAt: nowISO() })
          .where({ ID: tripId })
      );

      const stoppedTrip = await getTripById(db, tripId);
      return res.json(stoppedTrip);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/recordLocation", requireDriverSession, async (req, res, next) => {
    try {
      const { tripId, latitude, longitude } = req.body || {};
      if (!tripId) {
        return res.status(400).json({ error: "tripId is required" });
      }
      if (latitude == null || longitude == null) {
        return res.status(400).json({ error: "latitude and longitude are required" });
      }

      const db = await dbPromise;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }
      if (trip.status !== "ACTIVE") {
        return res.status(400).json({ error: "Trip is not active" });
      }

      const payload = {
        ID: cds.utils.uuid(),
        trip_ID: tripId,
        latitude,
        longitude,
        accuracy: req.body?.accuracy ?? null,
        altitude: req.body?.altitude ?? null,
        speed: req.body?.speed ?? null,
        heading: req.body?.heading ?? null,
        recordedAt: req.body?.recordedAt || nowISO(),
        source: req.body?.source || "browser-geolocation"
      };

      await db.run(INSERT.into("tracker.LocationPoints").entries(payload));
      return res.json(payload);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/path/:tripId", requireDriverSession, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const { tripId } = req.params;
      const trip = await getTripById(db, tripId);
      if (!trip) {
        return res.status(404).json({ error: "Trip not found" });
      }
      if (trip.driver_ID !== req.driver.ID) {
        return res.status(403).json({ error: "Drivers can only access their own trips" });
      }

      const points = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ trip_ID: tripId })
          .orderBy("recordedAt asc")
      );

      return res.json({ value: points });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/metrics", requireDriverSession, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const [tripCountRow] = await db.run(
        SELECT.from("tracker.Trips").where({ driver_ID: req.driver.ID }).columns("count(1) as count")
      );
      const [completedTripCountRow] = await db.run(
        SELECT.from("tracker.Trips")
          .where({ driver_ID: req.driver.ID, status: "COMPLETED" })
          .columns("count(1) as count")
      );
      const [pointCountRow] = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ "trip.driver_ID": req.driver.ID })
          .columns("count(1) as count")
      );
      const [accuracyAverageRow] = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ "trip.driver_ID": req.driver.ID, accuracy: { "!=": null } })
          .columns("avg(accuracy) as avgAccuracy")
      );

      const completedTrips = await db.run(
        SELECT.from("tracker.Trips")
          .where({ driver_ID: req.driver.ID, status: "COMPLETED" })
          .columns("startedAt", "endedAt")
      );

      const totalTrips = Number(tripCountRow?.count || 0);
      const totalCompletedTrips = Number(completedTripCountRow?.count || 0);
      const totalPoints = Number(pointCountRow?.count || 0);
      const completionRate = totalTrips ? roundToTwoDecimals((totalCompletedTrips / totalTrips) * 100) : 0;
      const avgPointsPerTrip = totalTrips ? roundToTwoDecimals(totalPoints / totalTrips) : 0;
      const avgGpsAccuracy = roundToTwoDecimals(Number(accuracyAverageRow?.avgAccuracy || 0));

      const durations = completedTrips
        .map((trip) => ({
          startedAt: trip.startedAt ? new Date(trip.startedAt).getTime() : null,
          endedAt: trip.endedAt ? new Date(trip.endedAt).getTime() : null
        }))
        .filter((trip) => Number.isFinite(trip.startedAt) && Number.isFinite(trip.endedAt) && trip.endedAt >= trip.startedAt)
        .map((trip) => trip.endedAt - trip.startedAt);

      const avgSessionDurationMs = durations.length
        ? roundToTwoDecimals(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : 0;

      return res.json({
        generatedAt: nowISO(),
        totalTrips,
        completedTrips: totalCompletedTrips,
        completionRate,
        totalPoints,
        avgPointsPerTrip,
        avgGpsAccuracy,
        avgSessionDurationMs,
        ingestAttempts: 0,
        ingestSuccess: 0,
        ingestFailure: 0,
        ingestSuccessRate: 0,
        avgIngestLatencyMs: 0
      });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/tracker/path/:tripId", async (req, res, next) => {
    try {
      const { tripId } = req.params;
      const db = await cds.connect.to("db");
      const authConfig = cds.requires.auth || {};

      if (authConfig.kind === "xsuaa") {
        // Require a Bearer token
        if (!req.headers.authorization) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const svc = getAuthService();
        if (!svc) {
          return res.status(500).json({ error: "XSUAA service not configured" });
        }

        // Verify the JWT – xssec extracts it from req.headers.authorization automatically
        let secCtx;
        try {
          secCtx = await createSecurityContext(svc, { req });
        } catch (err) {
          cds.log("server").warn("JWT verification failed:", err.message);
          return res.status(401).json({ error: "Invalid or expired token" });
        }

        const isDriver = secCtx.checkLocalScope("Driver");
        const isAdmin = secCtx.checkLocalScope("FleetAdmin");

        if (!isDriver && !isAdmin) {
          return res.status(403).json({ error: "Forbidden: requires Driver or FleetAdmin role" });
        }

        const email = normalizeEmail(secCtx.getLogonName());

        if (isDriver) {
          // Fail fast: check driver profile before fetching the trip
          const driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ email })
          );
          if (!driver || driver.status !== "ACTIVE") {
            return res.status(403).json({ error: "No active driver profile is assigned to this login" });
          }
          const trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          if (!trip) {
            return res.status(404).json({ error: "Trip not found" });
          }
          if (trip.driver_ID !== driver.ID) {
            return res.status(403).json({ error: "Drivers can only access their own trips" });
          }
        } else {
          // Fail fast: check admin profile before fetching the trip
          const admin = await db.run(
            SELECT.one.from("tracker.Admins").where({ email })
          );
          if (!admin) {
            return res.status(403).json({ error: "No admin profile found for this login" });
          }
          const trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          if (!trip) {
            return res.status(404).json({ error: "Trip not found" });
          }
          const driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ ID: trip.driver_ID })
          );
          if (!driver || driver.admin_ID !== admin.ID) {
            return res.status(403).json({ error: "Fleet admins can only access their own drivers' trips" });
          }
        }
      }

      const points = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ trip_ID: tripId })
          .orderBy("recordedAt asc")
      );

      res.json({ value: points });
    } catch (error) {
      next(error);
    }
  });
});
