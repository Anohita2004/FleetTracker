const cds = require("@sap/cds");
const bcrypt = require("bcryptjs");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { SELECT, INSERT, UPDATE } = cds.ql;
const { createSecurityContext, XsuaaService, XsaService } = require("@sap/xssec");

module.exports = cds.server;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();
const nowISO = () => new Date().toISOString();
const PASSWORD_MIN_LENGTH = 8;
const JWT_COOKIE_NAME = "driver_token";
const JWT_EXPIRES_IN = "8h";
const JWT_TTL_MS = 8 * 60 * 60 * 1000;
const DUMMY_BCRYPT_HASH = "$2b$10$hYQfIctt8V3M9zb5z/JEuOsj4dHww64JfQ3MNCWiA3f9aULphQxse";
const roundToTwoDecimals = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const resolveJwtSecret = () => {
  const configuredSecret = process.env.JWT_SECRET_KEY;
  if (configuredSecret) return configuredSecret;

  // In production, derive a stable secret from the XSUAA client credentials
  // so the JWT remains valid across server restarts and instances.
  const xsuaaCredentials = (cds.requires.auth || {}).credentials || {};
  const clientSecret = xsuaaCredentials.clientsecret || xsuaaCredentials.clientSecret;
  if (clientSecret) {
    return crypto.createHash("sha256").update("driver-jwt:" + clientSecret).digest("hex");
  }

  // Local development fallback
  return process.env.NODE_ENV === "production" ? null : "driver-jwt-dev-secret";
};

let jwtSecret = null;

const issueDriverToken = (driver, csrfToken) => jwt.sign({
  driverId: driver.ID,
  email: driver.email,
  role: "driver",
  csrf: csrfToken
}, jwtSecret, { expiresIn: JWT_EXPIRES_IN });

const getValidDriverPayload = (req) => {
  // Check Authorization header first (for Android app)
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    try {
      const payload = jwt.verify(authHeader.substring(7), jwtSecret);
      if (payload) return payload;
    } catch (e) {}
  }
  // If header fails (e.g. it was an XSUAA token from AppRouter), or doesn't exist, check cookie
  const cookieToken = req.cookies?.[JWT_COOKIE_NAME];
  if (cookieToken) {
    try {
      const payload = jwt.verify(cookieToken, jwtSecret);
      if (payload) return payload;
    } catch (e) {}
  }
  return null;
};

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
  jwtSecret = resolveJwtSecret();
  if (!jwtSecret) {
    throw new Error("JWT_SECRET_KEY must be configured in production for driver JWT sessions.");
  }

  // Enable trust proxy so Express knows it is behind the BTP AppRouter.
  // This is CRITICAL for 'secure: true' cookies to be set correctly over the HTTP proxy connection.
  app.set("trust proxy", 1);

  const cors = require("cors");
  app.use(cors({
    origin: true,
    credentials: true
  }));
  app.use(cookieParser());
  app.use(require("express").json());

  const fs = require('fs');
  const multer = require('multer');
  const uploadDir = 'uploads/driver-docs';
  fs.mkdirSync(uploadDir, { recursive: true });
  const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir); },
    filename: function (req, file, cb) {
      const driverId = (req.body && req.body.driverId) ? String(req.body.driverId) : cds.utils.uuid();
      cb(null, `${driverId}-${file.originalname}`);
    }
  });
  const upload = multer({ storage });

  // After XSUAA authenticates the admin via the /login route, the AppRouter forwards
  // the request here. We immediately redirect the browser to the real app URL so that
  // the UI5 bootstrap resolves "./" correctly against /comlocationtrackerlocationtracker/
  // instead of against /login (which would cause all Component.js/manifest.json loads to 503).
  app.get("/do/admin-login-redirect", (req, res) => {
    res.redirect(302, "/comlocationtrackerlocationtracker/index.html");
  });

  const dbPromise = cds.connect.to("db");
  const driverSelectFields = ["ID", "name", "email", "vehicleId", "phone", "isActive", "admin_ID"];

  const normalizeDriverRecord = (driver) => {
    if (!driver) return null;
    
    let isActive = driver.isActive !== undefined ? driver.isActive : driver.ISACTIVE;
    if (typeof isActive === "number") isActive = isActive === 1;
    else if (typeof isActive === "string") isActive = (isActive.trim().toLowerCase() === "true" || isActive.trim() === "1");
    else isActive = Boolean(isActive);

    return {
      ID: driver.ID || driver.id || driver.Id,
      name: driver.name || driver.NAME,
      email: driver.email || driver.EMAIL,
      vehicleId: driver.vehicleId || driver.VEHICLEID,
      phone: driver.phone || driver.PHONE,
      passwordHash: driver.passwordHash || driver.PASSWORDHASH,
      isActive,
      admin_ID: driver.admin_ID || driver.ADMIN_ID
    };
  };

  const getDriverByEmail = async (db, email) => {
    const res = await db.run(SELECT.one.from("tracker.Drivers").where({ email: normalizeEmail(email) }));
    return normalizeDriverRecord(res);
  };

  const getDriverById = async (db, driverId) => {
    const res = await db.run(SELECT.one.from("tracker.Drivers").columns(...driverSelectFields).where({ ID: driverId }));
    return normalizeDriverRecord(res);
  };

  const normalizeTripRecord = (trip) => {
    if (!trip) return null;
    return {
      ...trip,
      ID: trip.ID || trip.id || trip.Id,
      title: trip.title || trip.TITLE,
      driver_ID: trip.driver_ID || trip.DRIVER_ID,
      startedAt: trip.startedAt || trip.STARTEDAT,
      endedAt: trip.endedAt || trip.ENDEDAT,
      status: trip.status || trip.STATUS
    };
  };

  const getTripById = async (db, tripId) => {
    const res = await db.run(SELECT.one.from("tracker.Trips").where({ ID: tripId }));
    return normalizeTripRecord(res);
  };

  const normalizeTruckRecord = (truck) => {
    if (!truck) return null;
    return {
      ...truck,
      ID: truck.ID || truck.id || truck.Id,
      truckNumber: truck.truckNumber || truck.TRUCKNUMBER || truck.vehicle_number,
      model: truck.model || truck.MODEL,
      registrationNumber: truck.registrationNumber || truck.REGISTRATION_NUMBER || truck.registration_number,
      fuelType: truck.fuelType || truck.FUEL_TYPE,
      status: truck.status || truck.STATUS,
      latitude: truck.latitude !== undefined ? truck.latitude : truck.LATITUDE,
      longitude: truck.longitude !== undefined ? truck.longitude : truck.LONGITUDE,
      assignedDriver_ID: truck.assignedDriver_ID || truck.ASSIGNEDDRIVER_ID || (truck.assignedDriver && (truck.assignedDriver.ID || truck.assignedDriver.id)) || null,
      admin_ID: truck.admin_ID || truck.ADMIN_ID
    };
  };

  const getTruckById = async (db, truckId) => {
    const res = await db.run(SELECT.one.from("tracker.Trucks").where({ ID: truckId }));
    return normalizeTruckRecord(res);
  };

  const getActiveTrip = async (db, driverId) => {
    const res = await db.run(
      SELECT.one.from("tracker.Trips")
        .where({ status: "ACTIVE", driver_ID: driverId })
        .orderBy("startedAt desc")
    );
    return normalizeTripRecord(res);
  };

  app.use((req, res, next) => {
    if (req.user) {
      return next();
    }

    const payload = getValidDriverPayload(req);
    if (!payload) {
      return next();
    }

    req.driverToken = payload;
    req.user = new cds.User({
      id: payload.email,
      roles: ["Driver"],
      attr: { email: payload.email }
    });
    return next();
  });

  const requireDriverAuth = async (req, res, next) => {
    try {
      const payload = getValidDriverPayload(req);
      if (!payload) {
        return res.status(401).json({ error: "Driver login required" });
      }

      const db = await dbPromise;
      const driver = await getDriverById(db, payload.driverId);
      if (!driver || !driver.isActive) {
        return res.status(403).json({ error: "No active driver profile is assigned to this login" });
      }

      req.driverToken = payload;
      req.driver = driver;
      return next();
    } catch (error) {
      return next(error);
    }
  };

  const requireDriverCsrf = (req, res, next) => {
    const headerToken = req.headers["x-driver-csrf-token"];
    if (!headerToken || headerToken !== req.driverToken?.csrf) {
      return res.status(403).json({ error: "Invalid or missing CSRF token" });
    }
    return next();
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

      if (driver && driver.registrationStatus && driver.registrationStatus !== 'APPROVED') {
        return res.status(403).json({ error: "Your registration is pending admin approval" });
      }

      const hashToCompare = driver?.passwordHash || DUMMY_BCRYPT_HASH;
      const passwordOk = await bcrypt.compare(password, hashToCompare);
      if (!driver || !driver.isActive || !driver.passwordHash || !passwordOk) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const csrfToken = crypto.randomBytes(32).toString("hex");
      const token = issueDriverToken(driver, csrfToken);

      res.cookie(JWT_COOKIE_NAME, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "Strict",
        maxAge: JWT_TTL_MS
      });

      const response = {
        success: true,
        driver: {
          id: driver.ID,
          name: driver.name,
          email: driver.email
        },
        csrfToken
      };

      if (req.body?.mobile) {
        response.token = token;
      }

      return res.json(response);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/me", async (req, res) => {
    const payload = getValidDriverPayload(req);
    if (!payload) return res.status(401).json({ error: "Driver login required" });

    const db = await dbPromise;
    const driver = await getDriverById(db, payload.driverId);
    if (!driver || !driver.isActive) {
      return res.status(401).json({ error: "Driver login required" });
    }

    return res.json({
      driver,
      csrfToken: payload.csrf || null
    });
  });

  app.post("/drivers/logout", requireDriverAuth, requireDriverCsrf, async (req, res) => {
    res.clearCookie(JWT_COOKIE_NAME, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "Strict"
    });
    return res.json({ ok: true });
  });

  app.get("/drivers/activeTrip", requireDriverAuth, async (req, res, next) => {
    try {
      const db = await dbPromise;
      const trip = await getActiveTrip(db, req.driver.ID);
      return res.json(trip || null);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/drivers/startTrip", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
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

  app.post("/drivers/stopTrip", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
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

      if (trip.status !== "ACTIVE") {
        return res.status(400).json({ error: "Trip is not active" });
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

  app.post("/drivers/recordLocation", requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
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
        createdAt: nowISO(),
        source: req.body?.source || "browser-geolocation"
      };

      await db.run(INSERT.into("tracker.LocationPoints").entries(payload));
      return res.json(payload);
    } catch (error) {
      return next(error);
    }
  });

  const normalizePointRecord = (point) => {
    if (!point) return null;
    return {
      ...point,
      ID: point.ID || point.id || point.Id,
      trip_ID: point.trip_ID || point.TRIP_ID,
      latitude: point.latitude !== undefined ? point.latitude : point.LATITUDE,
      longitude: point.longitude !== undefined ? point.longitude : point.LONGITUDE,
      accuracy: point.accuracy !== undefined ? point.accuracy : point.ACCURACY,
      altitude: point.altitude !== undefined ? point.altitude : point.ALTITUDE,
      speed: point.speed !== undefined ? point.speed : point.SPEED,
      heading: point.heading !== undefined ? point.heading : point.HEADING,
      recordedAt: point.recordedAt || point.RECORDEDAT,
      createdAt: point.createdAt || point.CREATEDAT,
      source: point.source || point.SOURCE
    };
  };

  app.get("/drivers/path/:tripId", requireDriverAuth, async (req, res, next) => {
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

      const normalizedPoints = (points || []).map(normalizePointRecord);
      return res.json({ value: normalizedPoints });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/drivers/metrics", requireDriverAuth, async (req, res, next) => {
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

      const trips = await db.run(
        SELECT.from("tracker.Trips")
          .columns("ID", "startedAt", "endedAt", "status")
          .where({ driver_ID: req.driver.ID })
      );
      const tripIds = trips.map((t) => t.ID || t.id || t.Id);

      let totalPoints = 0;
      let avgGpsAccuracy = 0;
      let ingestSuccessRate = 0;
      let avgIngestLatencyMs = 0;

      if (tripIds.length > 0) {
        const [pointCountRow] = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds } })
            .columns("count(1) as count")
        );
        totalPoints = Number(pointCountRow?.count || pointCountRow?.COUNT || 0);

        const [accuracyAverageRow] = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds }, accuracy: { "!=": null } })
            .columns("avg(accuracy) as avgAccuracy")
        );
        avgGpsAccuracy = roundToTwoDecimals(Number(accuracyAverageRow?.avgAccuracy || accuracyAverageRow?.AVGACCURACY || 0));

        const timePoints = await db.run(
          SELECT.from("tracker.LocationPoints")
            .where({ trip_ID: { in: tripIds } })
            .columns("recordedAt", "createdAt")
        );

        const latencies = timePoints
          .map((p) => {
            const rAt = p.recordedAt || p.RECORDEDAT;
            const cAt = p.createdAt || p.CREATEDAT;
            return rAt && cAt ? new Date(cAt).getTime() - new Date(rAt).getTime() : -1;
          })
          .filter((l) => l >= 0);

        if (totalPoints > 0) {
          ingestSuccessRate = 100;
        }

        if (latencies.length > 0) {
          avgIngestLatencyMs = roundToTwoDecimals(latencies.reduce((a, b) => a + b, 0) / latencies.length);
        }
      }

      const totalTrips = Number(tripCountRow?.count || tripCountRow?.COUNT || 0);
      const totalCompletedTrips = Number(completedTripCountRow?.count || completedTripCountRow?.COUNT || 0);
      const completionRate = totalTrips ? roundToTwoDecimals((totalCompletedTrips / totalTrips) * 100) : 0;
      const avgPointsPerTrip = totalTrips ? roundToTwoDecimals(totalPoints / totalTrips) : 0;

      const durations = trips
        .filter((trip) => {
          const status = trip.status || trip.STATUS;
          return status === "COMPLETED";
        })
        .map((trip) => {
          const startedAt = trip.startedAt || trip.STARTEDAT;
          const endedAt = trip.endedAt || trip.ENDEDAT;
          return {
            startedAt: startedAt ? new Date(startedAt).getTime() : null,
            endedAt: endedAt ? new Date(endedAt).getTime() : null
          };
        })
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
        ingestSuccessRate,
        avgIngestLatencyMs
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
          let driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ email })
          );
          driver = normalizeDriverRecord(driver);
          if (!driver || !driver.isActive) {
            return res.status(403).json({ error: "No active driver profile is assigned to this login" });
          }
          let trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          trip = normalizeTripRecord(trip);
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
          let trip = await db.run(
            SELECT.one.from("tracker.Trips").where({ ID: tripId })
          );
          trip = normalizeTripRecord(trip);
          if (!trip) {
            return res.status(404).json({ error: "Trip not found" });
          }
          let driver = await db.run(
            SELECT.one.from("tracker.Drivers").where({ ID: trip.driver_ID })
          );
          driver = normalizeDriverRecord(driver);
          if (!driver || driver.admin_ID !== admin.ID) {
            return res.status(403).json({ error: "Fleet admins can only access their own drivers' trips" });
          }
        }
      } else {
        return res.status(403).json({ error: "Forbidden: authentication required" });
      }

      const rawPoints = await db.run(
        SELECT.from("tracker.LocationPoints")
          .where({ trip_ID: tripId })
          .orderBy("recordedAt asc")
      );

      const normalizedPoints = (rawPoints || []).map(normalizePointRecord);
      res.json({ value: normalizedPoints });
    } catch (error) {
      next(error);
    }
  });

  const requireAdminAuth = async (req, res, next) => {
    try {
      if (process.env.NODE_ENV === "production" || cds.requires.auth?.kind === "xsuaa") {
        if (!req.headers.authorization) {
          return res.status(401).json({ error: "Unauthorized" });
        }
        const svc = getAuthService();
        if (!svc) {
          return res.status(500).json({ error: "XSUAA service not configured" });
        }
        const { createSecurityContext } = require("@sap/xssec");
        let secCtx;
        try {
          secCtx = await createSecurityContext(svc, { req });
        } catch (err) {
          return res.status(401).json({ error: "Invalid or expired token" });
        }
        req.user = secCtx;
      }
      next();
    } catch (error) {
      next(error);
    }
  };

  app.get("/tracker/activeTrip/:driverId", requireAdminAuth, async (req, res, next) => {
    try {
      const db = await cds.connect.to("db");
      const secCtx = req.user;
      if (!secCtx && process.env.NODE_ENV === "production") return res.status(401).json({ error: "Unauthorized" });

      const isAdmin = secCtx ? secCtx.checkLocalScope("FleetAdmin") : true; // default true for local dev
      if (!isAdmin) {
        return res.status(403).json({ error: "Only fleet admins can access this" });
      }
      const email = secCtx ? secCtx.getLogonName() : "admin@fleet.com";
      let admin = await db.run(
        SELECT.one.from("tracker.Admins").where({ email: String(email || "").trim().toLowerCase() })
      );
      if (!admin) {
        return res.status(404).json({ error: "Admin profile not found" });
      }

      const driverId = req.params.driverId;
      let driver = await db.run(
        SELECT.one.from("tracker.Drivers").where({ ID: driverId })
      );
      driver = normalizeDriverRecord(driver);
      if (!driver || driver.admin_ID !== admin.ID) {
        return res.status(403).json({ error: "You can only access your own drivers" });
      }

      let activeTrip = await db.run(
        SELECT.one.from("tracker.Trips")
          .where({ status: "ACTIVE", driver_ID: driver.ID })
          .orderBy("startedAt desc")
      );
      activeTrip = normalizeTripRecord(activeTrip);

      res.json(activeTrip || null);
    } catch (error) {
      next(error);
    }
  });

  app.get("/tracker/driverMetrics/:driverId", requireAdminAuth, async (req, res, next) => {
    try {
      const db = await cds.connect.to("db");
      const secCtx = req.user;
      if (!secCtx && process.env.NODE_ENV === "production") return res.status(401).json({ error: "Unauthorized" });

      const isAdmin = secCtx ? secCtx.checkLocalScope("FleetAdmin") : true;
      if (!isAdmin) return res.status(403).json({ error: "Only fleet admins can access this" });

      const email = secCtx ? secCtx.getLogonName() : "admin@fleet.com";
      let admin = await db.run(
        SELECT.one.from("tracker.Admins").where({ email: String(email || "").trim().toLowerCase() })
      );
      if (!admin) return res.status(404).json({ error: "Admin profile not found" });

      const driverId = req.params.driverId;
      let driver = await db.run(
        SELECT.one.from("tracker.Drivers").where({ ID: driverId })
      );
      driver = normalizeDriverRecord(driver);
      if (!driver || driver.admin_ID !== admin.ID) {
        return res.status(403).json({ error: "You can only access your own drivers" });
      }

      const [tripCountRow] = await db.run(SELECT.from("tracker.Trips").where({ driver_ID: driverId }).columns("count(1) as count"));
      const [completedTripCountRow] = await db.run(SELECT.from("tracker.Trips").where({ driver_ID: driverId, status: "COMPLETED" }).columns("count(1) as count"));
      
      const tripsQuery = await db.run(SELECT.from("tracker.Trips").where({ driver_ID: driverId }).columns("ID", "startedAt", "endedAt", "status"));
      const tripIds = tripsQuery.map(t => t.ID || t.id || t.Id);
      let totalPoints = 0;
      let avgGpsAccuracy = 0;
      let ingestSuccessRate = 0;
      let avgIngestLatencyMs = 0;
      
      if (tripIds.length > 0) {
         const [pointCountRow] = await db.run(SELECT.from("tracker.LocationPoints").where({ trip_ID: { in: tripIds } }).columns("count(1) as count"));
         totalPoints = Number(pointCountRow?.count || pointCountRow?.COUNT || 0);
         const [accuracyAverageRow] = await db.run(SELECT.from("tracker.LocationPoints").where({ trip_ID: { in: tripIds }, accuracy: { "!=": null } }).columns("avg(accuracy) as avgAccuracy"));
         avgGpsAccuracy = Number(accuracyAverageRow?.avgAccuracy || accuracyAverageRow?.AVGACCURACY || 0);

         const timePoints = await db.run(
           SELECT.from("tracker.LocationPoints")
             .where({ trip_ID: { in: tripIds } })
             .columns("recordedAt", "createdAt")
         );

         const latencies = timePoints
           .map((p) => {
             const rAt = p.recordedAt || p.RECORDEDAT;
             const cAt = p.createdAt || p.CREATEDAT;
             return rAt && cAt ? new Date(cAt).getTime() - new Date(rAt).getTime() : -1;
           })
           .filter((l) => l >= 0);

         if (totalPoints > 0) {
           ingestSuccessRate = 100;
         }

         if (latencies.length > 0) {
           avgIngestLatencyMs = roundToTwoDecimals(latencies.reduce((a, b) => a + b, 0) / latencies.length);
         }
      }

      const totalTrips = Number(tripCountRow?.count || tripCountRow?.COUNT || 0);
      const totalCompletedTrips = Number(completedTripCountRow?.count || completedTripCountRow?.COUNT || 0);
      const completionRate = totalTrips ? (totalCompletedTrips / totalTrips) * 100 : 0;
      const avgPointsPerTrip = totalTrips ? (totalPoints / totalTrips) : 0;

      const durations = tripsQuery
        .filter((trip) => {
          const status = trip.status || trip.STATUS;
          return status === "COMPLETED";
        })
        .map((trip) => {
          const startedAt = trip.startedAt || trip.STARTEDAT;
          const endedAt = trip.endedAt || trip.ENDEDAT;
          return {
            startedAt: startedAt ? new Date(startedAt).getTime() : null,
            endedAt: endedAt ? new Date(endedAt).getTime() : null
          };
        })
        .filter((trip) => Number.isFinite(trip.startedAt) && Number.isFinite(trip.endedAt) && trip.endedAt >= trip.startedAt)
        .map((trip) => trip.endedAt - trip.startedAt);

      const avgSessionDurationMs = durations.length
        ? roundToTwoDecimals(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
        : 0;

      res.json({
        totalTrips,
        completedTrips: totalCompletedTrips,
        completionRate: roundToTwoDecimals(completionRate),
        totalPoints,
        avgPointsPerTrip: roundToTwoDecimals(avgPointsPerTrip),
        avgGpsAccuracy: roundToTwoDecimals(avgGpsAccuracy),
        avgSessionDurationMs,
        ingestSuccessRate,
        avgIngestLatencyMs
      });
    } catch (error) {
      next(error);
    }
  });

    // Lightweight admin profile endpoint for UI convenience
    app.get("/tracker/adminProfile", requireAdminAuth, async (req, res, next) => {
      try {
        const secCtx = req.user;
        if (!secCtx) return res.status(401).json({ error: "Unauthorized" });
        const db = await cds.connect.to("db");
        const email = typeof secCtx.getLogonName === 'function' ? normalizeEmail(secCtx.getLogonName()) : normalizeEmail(secCtx.id || secCtx.logonName || '');
        let admin = await db.run(SELECT.one.from("tracker.Admins").where({ email }));
        if (!admin) return res.status(404).json({ error: "Admin profile not found" });
        return res.json({ ID: admin.ID || admin.id, name: admin.name || admin.NAME, email: admin.email || admin.EMAIL });
      } catch (err) {
        next(err);
      }
    });

    // --- Truck management endpoints ---
    app.get("/tracker/trucks", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const trucks = await db.run(SELECT.from("tracker.Trucks").columns("*"));
        return res.json({ value: (trucks || []).map(normalizeTruckRecord) });
      } catch (err) {
        next(err);
      }
    });

    app.post("/tracker/trucks", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const payload = {
          ID: cds.utils.uuid(),
          truckNumber: req.body?.truckNumber ?? null,
          model: req.body?.model ?? null,
          registrationNumber: req.body?.registrationNumber ?? null,
          fuelType: req.body?.fuelType ?? null,
          status: req.body?.status || "IDLE",
          latitude: req.body?.latitude ?? null,
          longitude: req.body?.longitude ?? null,
          assignedDriver_ID: req.body?.assignedDriver_ID ?? null,
          admin_ID: req.body?.admin_ID ?? null
        };

        // Ensure admin_ID is set. Prefer the authenticated admin (req.user) when available.
        if (!payload.admin_ID) {
          let admin = null;
          try {
            const secCtx = req.user; // set by requireAdminAuth for XSUAA flows
            if (secCtx && typeof secCtx.getLogonName === 'function') {
              const email = normalizeEmail(secCtx.getLogonName());
              admin = await db.run(SELECT.one.from("tracker.Admins").where({ email }));
              if (!admin) {
                // create admin record
                const newAdmin = { ID: cds.utils.uuid(), name: email, email };
                await db.run(INSERT.into("tracker.Admins").entries(newAdmin));
                admin = newAdmin;
              }
            }

            // Fallback: use first existing admin in DB (local/dev convenience)
            if (!admin) {
              admin = await db.run(SELECT.one.from("tracker.Admins"));
            }
          } catch (e) {
            // ignore and validate below
          }

          if (!admin || !admin.ID) {
            return res.status(400).json({ error: "admin_ID is required; no admin context found" });
          }
          payload.admin_ID = admin.ID;
        }

        await db.run(INSERT.into("tracker.Trucks").entries(payload));
        const created = await getTruckById(db, payload.ID);
        return res.json(created);
      } catch (err) {
        next(err);
      }
    });

    app.put("/tracker/trucks/:id", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const id = req.params.id;
        const updates = {};
        ["truckNumber","model","registrationNumber","fuelType","status","latitude","longitude","assignedDriver_ID"].forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
        });
        await db.run(UPDATE("tracker.Trucks").set(updates).where({ ID: id }));
        const truck = await getTruckById(db, id);
        return res.json(truck);
      } catch (err) {
        next(err);
      }
    });

    app.delete("/tracker/trucks/:id", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const id = req.params.id;
        await db.run(UPDATE("tracker.Trucks").set({ status: "DEACTIVATED" }).where({ ID: id }));
        return res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    });

    app.post("/tracker/trucks/:id/assign", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const id = req.params.id;
        const driverId = req.body?.driverId;
        if (!driverId) return res.status(400).json({ error: "driverId required" });
        await db.run(UPDATE("tracker.Trucks").set({ assignedDriver_ID: driverId }).where({ ID: id }));
        const truck = await getTruckById(db, id);
        return res.json(truck);
      } catch (err) {
        next(err);
      }
    });

    app.post("/tracker/trucks/:id/status", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const id = req.params.id;
        const status = req.body?.status;
        if (!status) return res.status(400).json({ error: "status required" });
        await db.run(UPDATE("tracker.Trucks").set({ status }).where({ ID: id }));
        const truck = await getTruckById(db, id);
        return res.json(truck);
      } catch (err) {
        next(err);
      }
    });

    // --- Dashboard endpoint for fleet overview ---
    app.get("/tracker/dashboard", requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to("db");
        const [truckCountRow] = await db.run(SELECT.from("tracker.Trucks").columns("count(1) as count"));
        const totalTrucks = Number(truckCountRow?.count || 0);

        const [activeTripsRow] = await db.run(SELECT.from("tracker.Trips").where({ status: "ACTIVE" }).columns("count(1) as count"));
        const activeTrips = Number(activeTripsRow?.count || 0);

        const [completedTripsRow] = await db.run(SELECT.from("tracker.Trips").where({ status: "COMPLETED" }).columns("count(1) as count"));
        const completedTrips = Number(completedTripsRow?.count || 0);

        const now = new Date().toISOString();
        const delayedRows = await db.run(SELECT.from("tracker.Trips").where({ status: "ACTIVE", expectedEndAt: { "<": now } }).columns("ID"));
        const delayedDeliveries = (delayedRows || []).length;

        const activeTripDrivers = await db.run(SELECT.from("tracker.Trips").where({ status: "ACTIVE" }).columns("driver_ID"));
        const activeDriverIds = new Set((activeTripDrivers || []).map(d => d.driver_ID || d.DRIVER_ID));
        const allDrivers = await db.run(SELECT.from("tracker.Drivers").where({ isActive: true }).columns("ID"));
        const availableDrivers = (allDrivers || []).filter(d => !activeDriverIds.has(d.ID || d.id || d.Id));

        const trucks = await db.run(SELECT.from("tracker.Trucks").columns("*") );
        const normalizedTrucks = (trucks || []).map(normalizeTruckRecord);

        return res.json({
          generatedAt: nowISO(),
          totalTrucks,
          activeTrips,
          completedTrips,
          delayedDeliveries,
          availableDrivers: availableDrivers.length,
          trucks: normalizedTrucks
        });
      } catch (err) {
        next(err);
      }
    });

    // --- Self-registration endpoints ---
    app.post('/drivers/register', async (req, res, next) => {
      try {
        const { name, email, password, phone, licenseNumber, licenseExpiry } = req.body || {};
        if (!name || !email || !password || !phone || !licenseNumber) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        if (String(email).indexOf('@') === -1) {
          return res.status(400).json({ error: 'Invalid email address' });
        }
        if (String(password).length < PASSWORD_MIN_LENGTH) {
          return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters` });
        }

        const db = await dbPromise;
        const existing = await db.run(SELECT.one.from('tracker.Drivers').where({ email: normalizeEmail(email) }));
        if (existing) {
          return res.status(409).json({ error: 'Email already registered' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const entry = {
          ID: cds.utils.uuid(),
          name,
          email: normalizeEmail(email),
          passwordHash,
          phone,
          licenseNumber: licenseNumber || null,
          licenseExpiry: licenseExpiry || null,
          registrationStatus: 'PENDING',
          isActive: false,
          admin_ID: null,
          createdAt: nowISO()
        };

        await db.run(INSERT.into('tracker.Drivers').entries(entry));
        return res.status(201).json({ success: true, message: 'Registration submitted. Await admin approval.', driverId: entry.ID });
      } catch (err) {
        next(err);
      }
    });

    app.post('/drivers/register/upload-doc', upload.single('document'), async (req, res, next) => {
      try {
        const driverId = req.body?.driverId;
        if (!driverId) return res.status(400).json({ error: 'driverId is required' });
        if (!req.file) return res.status(400).json({ error: 'document file is required' });

        const documentUrl = `${uploadDir}/${req.file.filename}`;
        const db = await dbPromise;
        await db.run(UPDATE('tracker.Drivers').set({ documentUrl }).where({ ID: driverId }));
        return res.json({ success: true, documentUrl });
      } catch (err) {
        next(err);
      }
    });

    // --- Admin registration management ---
    app.get('/tracker/pending-registrations', requireAdminAuth, async (req, res, next) => {
      try {
        const secCtx = req.user;
        if (!secCtx && process.env.NODE_ENV === 'production') return res.status(401).json({ error: 'Unauthorized' });
        const db = await cds.connect.to('db');
        const pending = await db.run(SELECT.from('tracker.Drivers').columns('ID','name','email','phone','licenseNumber','licenseExpiry','documentUrl','createdAt').where({ registrationStatus: 'PENDING' }).orderBy('createdAt desc'));
        return res.json({ value: pending || [] });
      } catch (err) {
        next(err);
      }
    });

    app.post('/tracker/drivers/:id/approve', requireAdminAuth, async (req, res, next) => {
      try {
        const secCtx = req.user;
        if (!secCtx && process.env.NODE_ENV === 'production') return res.status(401).json({ error: 'Unauthorized' });
        const db = await cds.connect.to('db');
        const email = typeof secCtx.getLogonName === 'function' ? normalizeEmail(secCtx.getLogonName()) : normalizeEmail(secCtx.id || secCtx.logonName || '');
        let admin = await db.run(SELECT.one.from('tracker.Admins').where({ email }));
        if (!admin) return res.status(404).json({ error: 'Admin profile not found' });

        const driverId = req.params.id;
        await db.run(UPDATE('tracker.Drivers').set({ registrationStatus: 'APPROVED', isActive: true, admin_ID: admin.ID }).where({ ID: driverId }));
        const updated = await db.run(SELECT.one.from('tracker.Drivers').columns(...driverSelectFields, 'registrationStatus').where({ ID: driverId }));
        if (!updated) return res.status(404).json({ error: 'Driver not found' });
        return res.json(updated);
      } catch (err) {
        next(err);
      }
    });

    app.post('/tracker/drivers/:id/reject', requireAdminAuth, async (req, res, next) => {
      try {
        const driverId = req.params.id;
        const reason = req.body?.reason || null;
        const db = await cds.connect.to('db');
        const result = await db.run(UPDATE('tracker.Drivers').set({ registrationStatus: 'REJECTED', isActive: false }).where({ ID: driverId }));
        // Check if driver exists
        const driver = await db.run(SELECT.one.from('tracker.Drivers').where({ ID: driverId }));
        if (!driver) return res.status(404).json({ error: 'Driver not found' });
        return res.json({ success: true, driverId, reason });
      } catch (err) {
        next(err);
      }
    });

    // --- Additional TMS endpoints ---
    // Helper: resolve admin from req.user
    const getAdminFromReq = async (db, req) => {
      const secCtx = req.user;
      if (!secCtx) return null;
      const email = normalizeEmail(
        typeof secCtx.getLogonName === 'function' ? secCtx.getLogonName() : secCtx.id || ''
      );
      return await db.run(SELECT.one.from('tracker.Admins').where({ email }));
    };

    // Endpoint 1: Create Freight Order
    app.post('/tracker/freight-orders', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const { orderNumber, truck_ID, driver_ID, origin, destination, plannedDeparture, plannedArrival, checkpointCount } = req.body || {};
        if (!truck_ID || !driver_ID || !origin || !destination) {
          return res.status(400).json({ error: 'truck_ID, driver_ID, origin and destination are required' });
        }

        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ ID: truck_ID, admin_ID: admin.ID }));
        if (!truck) return res.status(403).json({ error: 'Truck does not belong to this admin' });

        const driver = await db.run(SELECT.one.from('tracker.Drivers').where({ ID: driver_ID, admin_ID: admin.ID, registrationStatus: 'APPROVED' }));
        if (!driver) return res.status(403).json({ error: 'Driver not found or not approved under this admin' });

        const entry = {
          ID: cds.utils.uuid(),
          orderNumber: orderNumber || null,
          admin_ID: admin.ID,
          truck_ID,
          driver_ID,
          origin,
          destination,
          plannedDeparture: plannedDeparture || null,
          plannedArrival: plannedArrival || null,
          actualArrival: null,
          status: 'PLANNED',
          checkpointCount: checkpointCount || 0,
          createdAt: nowISO()
        };

        await db.run(INSERT.into('tracker.FreightOrders').entries(entry));
        const created = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: entry.ID }));
        return res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 2: List Freight Orders
    app.get('/tracker/freight-orders', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const statusFilter = req.query?.status;
        const where = { admin_ID: admin.ID };
        if (statusFilter) where.status = statusFilter;

        const orders = await db.run(SELECT.from('tracker.FreightOrders').where(where).orderBy('createdAt desc'));

        const truckIds = Array.from(new Set((orders || []).map(o => o.truck_ID).filter(Boolean)));
        const driverIds = Array.from(new Set((orders || []).map(o => o.driver_ID).filter(Boolean)));

        const trucks = truckIds.length ? await db.run(SELECT.from('tracker.Trucks').where({ ID: { in: truckIds } })) : [];
        const drivers = driverIds.length ? await db.run(SELECT.from('tracker.Drivers').where({ ID: { in: driverIds } })) : [];

        const truckMap = {}; (trucks || []).forEach(t => { truckMap[t.ID || t.id] = t; });
        const driverMap = {}; (drivers || []).forEach(d => { driverMap[d.ID || d.id] = d; });

        const enriched = (orders || []).map(o => ({
          ...o,
          truckNumber: truckMap[o.truck_ID]?.truckNumber || null,
          driverName: driverMap[o.driver_ID]?.name || null
        }));

        return res.json({ value: enriched });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 3: Update Freight Order
    app.put('/tracker/freight-orders/:id', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const existing = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: id }));
        if (!existing) return res.status(404).json({ error: 'Freight order not found' });
        if (existing.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        const updates = {};
        [ 'status', 'checkpointCount', 'plannedDeparture', 'plannedArrival', 'actualArrival' ].forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
        });

        if (Object.keys(updates).length > 0) {
          await db.run(UPDATE('tracker.FreightOrders').set(updates).where({ ID: id }));
        }

        const updated = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: id }));
        return res.json(updated);
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 4: Dispatch Freight Order (create Trip)
    app.post('/tracker/freight-orders/:id/dispatch', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const order = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: id }));
        if (!order) return res.status(404).json({ error: 'Freight order not found' });
        if (order.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });
        if (order.status !== 'PLANNED') return res.status(400).json({ error: 'Only PLANNED orders can be dispatched' });
        if (order.trip_ID) return res.status(400).json({ error: 'Order already has a linked trip' });

        const newTrip = {
          ID: cds.utils.uuid(),
          title: `Freight Order ${order.orderNumber || order.ID} — ${order.origin || ''} to ${order.destination || ''}`,
          driver_ID: order.driver_ID,
          startedAt: nowISO(),
          status: 'ACTIVE',
          checkpointCount: order.checkpointCount || 0,
          freightOrder_ID: order.ID
        };

        await db.run(INSERT.into('tracker.Trips').entries(newTrip));
        await db.run(UPDATE('tracker.FreightOrders').set({ status: 'DISPATCHED', trip_ID: newTrip.ID }).where({ ID: order.ID }));

        const updatedOrder = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: order.ID }));
        return res.json({ freightOrder: updatedOrder, trip: newTrip });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 5: Create Gate Pass
    app.post('/tracker/gate-passes', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const { freightOrder_ID, truck_ID, driver_ID, gateOfficer, direction, remarks } = req.body || {};
        if (!freightOrder_ID || !direction) return res.status(400).json({ error: 'freightOrder_ID and direction are required' });
        if (!(direction === 'OUT' || direction === 'IN')) return res.status(400).json({ error: 'direction must be OUT or IN' });

        const order = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: freightOrder_ID }));
        if (!order) return res.status(404).json({ error: 'Freight order not found' });
        if (order.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        const dbDirection = direction === 'IN' ? 'INN' : 'OUT';

        const entry = {
          ID: cds.utils.uuid(),
          freightOrder_ID,
          truck_ID: truck_ID || null,
          driver_ID: driver_ID || null,
          gateOfficer: gateOfficer || null,
          direction: dbDirection,
          passedAt: nowISO(),
          remarks: remarks || null,
          status: 'APPROVED',
          createdAt: nowISO()
        };

        await db.run(INSERT.into('tracker.GatePasses').entries(entry));
        const created = await db.run(SELECT.one.from('tracker.GatePasses').where({ ID: entry.ID }));
        return res.status(201).json(created);
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 6: List Gate Passes
    app.get('/tracker/gate-passes', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const orders = await db.run(SELECT.from('tracker.FreightOrders').where({ admin_ID: admin.ID }).columns('ID'));
        const orderIds = (orders || []).map(o => o.ID);
        if (orderIds.length === 0) return res.json({ value: [] });

        const truckId = req.query?.truckId;
        const freightOrderId = req.query?.freightOrderId;

        const where = { freightOrder_ID: { in: orderIds } };
        if (truckId) where.truck_ID = truckId;
        if (freightOrderId) where.freightOrder_ID = freightOrderId;

        const passes = await db.run(SELECT.from('tracker.GatePasses').where(where).orderBy('passedAt desc'));

        const truckIds = Array.from(new Set((passes || []).map(p => p.truck_ID).filter(Boolean)));
        const driverIds = Array.from(new Set((passes || []).map(p => p.driver_ID).filter(Boolean)));
        const freightIds = Array.from(new Set((passes || []).map(p => p.freightOrder_ID).filter(Boolean)));

        const trucks = truckIds.length ? await db.run(SELECT.from('tracker.Trucks').where({ ID: { in: truckIds } })) : [];
        const drivers = driverIds.length ? await db.run(SELECT.from('tracker.Drivers').where({ ID: { in: driverIds } })) : [];
        const freights = freightIds.length ? await db.run(SELECT.from('tracker.FreightOrders').where({ ID: { in: freightIds } })) : [];

        const truckMap = {}; (trucks || []).forEach(t => { truckMap[t.ID || t.id] = t; });
        const driverMap = {}; (drivers || []).forEach(d => { driverMap[d.ID || d.id] = d; });
        const orderMap = {}; (freights || []).forEach(f => { orderMap[f.ID || f.id] = f; });

        const enriched = (passes || []).map(p => ({
          ...p,
          truckNumber: truckMap[p.truck_ID]?.truckNumber || null,
          driverName: driverMap[p.driver_ID]?.name || null,
          orderNumber: orderMap[p.freightOrder_ID]?.orderNumber || null
        }));

        return res.json({ value: enriched });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 7: Driver checkpoint status
    app.get('/drivers/checkpoint-status', requireDriverAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const trip = await getActiveTrip(db, req.driver.ID);
        if (!trip) return res.json({ hasActiveTrip: false, checkpointCount: 0, submitted: 0, nextCheckpointNo: null });
        if (!trip.checkpointCount || trip.checkpointCount === 0) {
          return res.json({ hasActiveTrip: true, checkpointCount: 0, submitted: 0, nextCheckpointNo: null, message: 'No checkpoints required for this trip' });
        }

        const freightOrderId = trip.freightOrder_ID;
        const rows = await db.run(SELECT.from('tracker.CheckpointReadings').where({ freightOrder_ID: freightOrderId }).columns('count(1) as count'));
        const submitted = Number(rows?.[0]?.count || 0);
        return res.json({
          hasActiveTrip: true,
          tripId: trip.ID,
          freightOrder_ID: freightOrderId,
          checkpointCount: trip.checkpointCount,
          submitted,
          remaining: trip.checkpointCount - submitted,
          nextCheckpointNo: submitted + 1,
          isComplete: submitted >= trip.checkpointCount
        });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 8: Submit checkpoint reading
    app.post('/drivers/checkpoints', requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const { freightOrder_ID, checkpointNo, fuelLitres, tyreFL, tyreFR, tyreRL, tyreRR, odometerKm, driverNote, latitude, longitude } = req.body || {};
        if (!freightOrder_ID || checkpointNo == null) return res.status(400).json({ error: 'freightOrder_ID and checkpointNo are required' });

        const trip = await getActiveTrip(db, req.driver.ID);
        if (!trip) return res.status(400).json({ error: 'No active trip' });
        if (String(trip.freightOrder_ID) !== String(freightOrder_ID)) return res.status(403).json({ error: 'Checkpoint does not belong to current trip' });

        const freight = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: freightOrder_ID }));
        if (!freight) return res.status(404).json({ error: 'Freight order not found' });
        if (checkpointNo > (freight.checkpointCount || 0)) return res.status(400).json({ error: 'Checkpoint number exceeds required count for this trip' });

        const existing = await db.run(SELECT.one.from('tracker.CheckpointReadings').where({ freightOrder_ID, checkpointNo }));
        if (existing) return res.status(409).json({ error: 'Checkpoint already submitted' });

        const entry = {
          ID: cds.utils.uuid(),
          freightOrder_ID,
          checkpointNo,
          fuelLitres: fuelLitres ?? null,
          tyreFL: tyreFL ?? null,
          tyreFR: tyreFR ?? null,
          tyreRL: tyreRL ?? null,
          tyreRR: tyreRR ?? null,
          odometerKm: odometerKm ?? null,
          driverNote: driverNote || null,
          latitude: latitude ?? null,
          longitude: longitude ?? null,
          capturedAt: nowISO(),
          createdAt: nowISO()
        };

        await db.run(INSERT.into('tracker.CheckpointReadings').entries(entry));
        return res.status(201).json(entry);
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 9: List checkpoints for freight order
    app.get('/tracker/freight-orders/:id/checkpoints', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const order = await db.run(SELECT.one.from('tracker.FreightOrders').where({ ID: id }));
        if (!order) return res.status(404).json({ error: 'Freight order not found' });
        if (order.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        const readings = await db.run(SELECT.from('tracker.CheckpointReadings').where({ freightOrder_ID: id }).orderBy('checkpointNo asc'));
        return res.json({ freightOrder_ID: id, checkpointCount: order.checkpointCount || 0, readings: readings || [] });
      } catch (err) {
        next(err);
      }
    });

    // --- Vehicle metrics & alerting endpoints ---

    const METRIC_TYPES = {
      FUEL_LEVEL:    'FUEL_LEVEL',
      TYRE_PRESSURE: 'TYRE_PRESSURE',
      ENGINE_TEMP:   'ENGINE_TEMP'
    };

    // Endpoint 1: Submit vehicle metrics (driver)
    app.post('/drivers/vehicle-metrics', requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const body = req.body || {};
        const hasAny = ['fuelLitres','tyreFL','tyreFR','tyreRL','tyreRR','engineTempC','odometerKm'].some(k => Object.prototype.hasOwnProperty.call(body, k) && body[k] != null);
        if (!hasAny) return res.status(400).json({ error: 'At least one metric value is required' });

        const activeTrip = await getActiveTrip(db, req.driver.ID);

        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ assignedDriver_ID: req.driver.ID }).where({ status: { '!=': 'DEACTIVATED' } }));
        // Note: cds.ql doesn't support two where() chained like that; ensure unified where
        // We'll instead run a single where with both conditions
      } catch (err) {
        next(err);
      }
    });

    // To avoid code duplication for correct truck selection, replace previous handler with full implementation
    // Rewriting the /drivers/vehicle-metrics handler
    app.post('/drivers/vehicle-metrics', requireDriverAuth, requireDriverCsrf, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const body = req.body || {};
        const keys = ['fuelLitres','tyreFL','tyreFR','tyreRL','tyreRR','engineTempC','odometerKm'];
        const hasAny = keys.some(k => Object.prototype.hasOwnProperty.call(body, k) && body[k] != null);
        if (!hasAny) return res.status(400).json({ error: 'At least one metric value is required' });

        const activeTrip = await getActiveTrip(db, req.driver.ID);

        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ assignedDriver_ID: req.driver.ID, status: { '!=': 'DEACTIVATED' } }));
        if (!truck) return res.status(404).json({ error: 'No active truck assigned to this driver' });

        const entry = {
          ID: cds.utils.uuid(),
          truck_ID: truck.ID,
          trip_ID: activeTrip?.ID || null,
          fuelLitres: body.fuelLitres ?? null,
          tyreFL: body.tyreFL ?? null,
          tyreFR: body.tyreFR ?? null,
          tyreRL: body.tyreRL ?? null,
          tyreRR: body.tyreRR ?? null,
          engineTempC: body.engineTempC ?? null,
          odometerKm: body.odometerKm ?? null,
          source: 'MANUAL',
          capturedAt: nowISO(),
          createdAt: nowISO()
        };

        await db.run(INSERT.into('tracker.VehicleMetrics').entries(entry));
        return res.status(201).json(entry);
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 2: Get truck metrics (admin)
    app.get('/tracker/trucks/:id/metrics', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ ID: id }));
        if (!truck) return res.status(404).json({ error: 'Truck not found' });
        if (truck.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        let limit = parseInt(req.query?.limit) || 50;
        if (limit <= 0) limit = 50;
        if (limit > 200) limit = 200;

        const where = { truck_ID: id };
        if (req.query?.from) where.capturedAt = Object.assign({}, where.capturedAt || {}, { '>=': req.query.from });
        if (req.query?.to) where.capturedAt = Object.assign({}, where.capturedAt || {}, { '<=': req.query.to });

        const readings = await db.run(SELECT.from('tracker.VehicleMetrics').where(where).orderBy('capturedAt desc').limit(limit));

        // compute summary
        const fuelVals = (readings || []).map(r => r.fuelLitres).filter(v => v != null).map(Number);
        const avgFuel = fuelVals.length ? roundToTwoDecimals(fuelVals.reduce((a,b)=>a+b,0)/fuelVals.length) : 0;

        const tyreVals = (readings || []).flatMap(r => [r.tyreFL, r.tyreFR, r.tyreRL, r.tyreRR].filter(v => v != null).map(Number));
        const minTyre = tyreVals.length ? Math.min(...tyreVals) : null;

        const engineVals = (readings || []).map(r => r.engineTempC).filter(v => v != null).map(Number);
        const maxEngine = engineVals.length ? Math.max(...engineVals) : null;

        const summary = {
          avgFuelLitres: avgFuel,
          minTyrePressure: minTyre,
          maxEngineTemp: maxEngine,
          totalReadings: (readings || []).length
        };

        return res.json({ truck_ID: id, summary, readings: readings || [] });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 3: Upsert alert thresholds for truck
    app.post('/tracker/trucks/:id/thresholds', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ ID: id }));
        if (!truck) return res.status(404).json({ error: 'Truck not found' });
        if (truck.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        const body = req.body || {};
        const upserted = [];

        for (const metricKey of Object.keys(METRIC_TYPES)) {
          const metricType = METRIC_TYPES[metricKey];
          const cfg = body[metricType];
          if (!cfg) continue;
          const { warningAt, criticalAt } = cfg;

          // validation
          if (metricType === METRIC_TYPES.FUEL_LEVEL || metricType === METRIC_TYPES.TYRE_PRESSURE) {
            if (criticalAt >= warningAt) return res.status(400).json({ error: `${metricType}: criticalAt must be less than warningAt` });
          } else if (metricType === METRIC_TYPES.ENGINE_TEMP) {
            if (criticalAt <= warningAt) return res.status(400).json({ error: `${metricType}: criticalAt must be greater than warningAt` });
          }

          const existing = await db.run(SELECT.one.from('tracker.AlertThresholds').where({ truck_ID: id, metricType }));
          if (existing) {
            await db.run(UPDATE('tracker.AlertThresholds').set({ warningAt, criticalAt, admin_ID: admin.ID }).where({ ID: existing.ID }));
            const updated = await db.run(SELECT.one.from('tracker.AlertThresholds').where({ ID: existing.ID }));
            upserted.push(updated);
          } else {
            const entry = { ID: cds.utils.uuid(), truck_ID: id, admin_ID: admin.ID, metricType, warningAt: warningAt ?? null, criticalAt: criticalAt ?? null, createdAt: nowISO() };
            await db.run(INSERT.into('tracker.AlertThresholds').entries(entry));
            upserted.push(await db.run(SELECT.one.from('tracker.AlertThresholds').where({ ID: entry.ID })));
          }
        }

        return res.json({ truck_ID: id, thresholds: upserted });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 4: Get alert thresholds for truck
    app.get('/tracker/trucks/:id/thresholds', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ ID: id }));
        if (!truck) return res.status(404).json({ error: 'Truck not found' });
        if (truck.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        const thresholds = await db.run(SELECT.from('tracker.AlertThresholds').where({ truck_ID: id }));
        return res.json({ truck_ID: id, thresholds: thresholds || [] });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 5: List alerts for admin
    app.get('/tracker/alerts', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const trucks = await db.run(SELECT.from('tracker.Trucks').where({ admin_ID: admin.ID }).columns('ID','truckNumber'));
        const truckIds = (trucks || []).map(t => t.ID);
        const truckMap = {}; (trucks || []).forEach(t => { truckMap[t.ID] = t; });

        const filterTruckId = req.query?.truckId;
        if (filterTruckId && !truckIds.includes(filterTruckId)) return res.status(403).json({ error: 'Forbidden' });

        const where = { truck_ID: { in: truckIds } };
        if (filterTruckId) where.truck_ID = filterTruckId;
        if (!(req.query?.includeRead === 'true' || req.query?.includeRead === true)) {
          where.isRead = false;
        }

        const alerts = await db.run(SELECT.from('tracker.AlertEvents').where(where).orderBy('firedAt desc'));
        const unreadCount = (alerts || []).filter(a => !a.isRead).length;
        const enriched = (alerts || []).map(a => ({ ...a, truckNumber: truckMap[a.truck_ID]?.truckNumber || null }));
        return res.json({ unreadCount, alerts: enriched });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 6: Mark single alert as read
    app.post('/tracker/alerts/:id/read', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const alertId = req.params.id;
        const alert = await db.run(SELECT.one.from('tracker.AlertEvents').where({ ID: alertId }));
        if (!alert) return res.status(404).json({ error: 'Alert not found' });
        const trucks = await db.run(SELECT.from('tracker.Trucks').where({ admin_ID: admin.ID }).columns('ID'));
        const truckIds = (trucks || []).map(t => t.ID);
        if (!truckIds.includes(alert.truck_ID)) return res.status(403).json({ error: 'Forbidden' });

        await db.run(UPDATE('tracker.AlertEvents').set({ isRead: true }).where({ ID: alertId }));
        return res.json({ success: true, alertId });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 7: Mark all alerts as read for admin's trucks
    app.post('/tracker/alerts/read-all', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const trucks = await db.run(SELECT.from('tracker.Trucks').where({ admin_ID: admin.ID }).columns('ID'));
        const truckIds = (trucks || []).map(t => t.ID);
        if (truckIds.length === 0) return res.json({ success: true, markedRead: 0 });

        const toMark = await db.run(SELECT.from('tracker.AlertEvents').where({ truck_ID: { in: truckIds }, isRead: false }).columns('ID'));
        const count = (toMark || []).length;
        if (count > 0) {
          await db.run(UPDATE('tracker.AlertEvents').set({ isRead: true }).where({ truck_ID: { in: truckIds }, isRead: false }));
        }

        return res.json({ success: true, markedRead: count });
      } catch (err) {
        next(err);
      }
    });

    // --- Background alert evaluation engine ---
    const ALERT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

    const evaluateAlerts = async () => {
      try {
        const db = await dbPromise;
        const thresholds = await db.run(SELECT.from('tracker.AlertThresholds'));
        const byTruck = new Map();
        (thresholds || []).forEach(t => {
          const tid = t.truck_ID || t.TRUCK_ID;
          if (!tid) return;
          if (!byTruck.has(tid)) byTruck.set(tid, {});
          byTruck.get(tid)[t.metricType] = t;
        });

        let evaluated = 0;
        let fired = 0;

        const nowMs = Date.now();
        for (const [truckId, thrMap] of byTruck.entries()) {
          evaluated += 1;
          const metrics = await db.run(SELECT.one.from('tracker.VehicleMetrics').where({ truck_ID: truckId }).orderBy('capturedAt desc'));
          if (!metrics) continue;
          const capturedAt = metrics.capturedAt || metrics.CAPTUREDAT || null;
          if (!capturedAt) continue;
          const capturedMs = new Date(capturedAt).getTime();
          if (isNaN(capturedMs)) continue;
          if (nowMs - capturedMs > 30 * 60 * 1000) continue; // older than 30 minutes

          for (const metricType of Object.values(METRIC_TYPES)) {
            const threshold = thrMap[metricType];
            if (!threshold) continue;
            let value = null;
            if (metricType === METRIC_TYPES.FUEL_LEVEL) value = metrics.fuelLitres ?? metrics.FUELLITRES;
            else if (metricType === METRIC_TYPES.TYRE_PRESSURE) {
              const tyres = [metrics.tyreFL, metrics.tyreFR, metrics.tyreRL, metrics.tyreRR].map(v => v == null ? null : Number(v)).filter(v => v != null);
              value = tyres.length ? Math.min(...tyres) : null;
            } else if (metricType === METRIC_TYPES.ENGINE_TEMP) value = metrics.engineTempC ?? metrics.ENGINETEMPC;

            if (value == null) continue;

            let severity = null;
            if (metricType === METRIC_TYPES.FUEL_LEVEL || metricType === METRIC_TYPES.TYRE_PRESSURE) {
              if (threshold.criticalAt != null && Number(value) <= Number(threshold.criticalAt)) severity = 'CRITICAL';
              else if (threshold.warningAt != null && Number(value) <= Number(threshold.warningAt)) severity = 'WARNING';
            } else if (metricType === METRIC_TYPES.ENGINE_TEMP) {
              if (threshold.criticalAt != null && Number(value) >= Number(threshold.criticalAt)) severity = 'CRITICAL';
              else if (threshold.warningAt != null && Number(value) >= Number(threshold.warningAt)) severity = 'WARNING';
            }

            if (!severity) continue;

            // check duplicate unread alert
            const exists = await db.run(SELECT.one.from('tracker.AlertEvents').where({ truck_ID: truckId, metricType, severity, isRead: false }));
            if (exists) continue;

            const alertEntry = {
              ID: cds.utils.uuid(),
              truck_ID: truckId,
              trip_ID: metrics.trip_ID || null,
              metricType,
              severity,
              value: Number(value),
              threshold: severity === 'CRITICAL' ? (threshold.criticalAt ?? null) : (threshold.warningAt ?? null),
              isRead: false,
              firedAt: nowISO(),
              createdAt: nowISO()
            };

            await db.run(INSERT.into('tracker.AlertEvents').entries(alertEntry));
            fired += 1;
          }
        }

        cds.log('alert-engine').info(`Alert run complete. Evaluated ${evaluated} trucks, fired ${fired} alerts.`);
      } catch (err) {
        cds.log('alert-engine').error('Alert evaluation failed:', err.message);
      }
    };

    setInterval(evaluateAlerts, ALERT_INTERVAL_MS);
    setTimeout(evaluateAlerts, 15000);

    // --- Reporting endpoints (per-truck, fleet, export) ---
    // Load ExcelJS only for report endpoints
    const ExcelJS = require('exceljs');

    const parseDateRange = (query) => {
      const from = query.from ? new Date(query.from).toISOString() : null;
      const to   = query.to   ? new Date(query.to).toISOString()   : null;
      if (from && isNaN(Date.parse(query.from))) throw new Error('Invalid from date');
      if (to   && isNaN(Date.parse(query.to)))   throw new Error('Invalid to date');
      return { from, to };
    };

    const buildTruckReport = async (db, truckId, from, to) => {
      // 1. Trips
      const tripWhere = { truck_ID: truckId };  // note: Trips has driver_ID not truck_ID
      // Trips are linked via FreightOrders — fetch freight orders for this truck, get trip IDs
      const freightOrders = await db.run(
        SELECT.from('tracker.FreightOrders')
          .where({ truck_ID: truckId })
          .columns('ID', 'trip_ID', 'status', 'plannedDeparture', 'actualArrival', 'plannedArrival', 'checkpointCount')
      );
      const tripIds = freightOrders.map(o => o.trip_ID).filter(Boolean);

      // 2. Trips data
      let trips = [];
      if (tripIds.length > 0) {
        trips = await db.run(
          SELECT.from('tracker.Trips')
            .where({ ID: { in: tripIds } })
            .columns('ID', 'startedAt', 'endedAt', 'status', 'checkpointCount')
        );
        if (from) trips = trips.filter(t => t.startedAt >= from);
        if (to)   trips = trips.filter(t => t.startedAt <= to);
      }

      const completedTrips = (trips || []).filter(t => t.status === 'COMPLETED');

      // 3. Durations
      const durations = completedTrips
        .filter(t => t.startedAt && t.endedAt)
        .map(t => new Date(t.endedAt).getTime() - new Date(t.startedAt).getTime());
      const avgTripDurationMs = durations.length
        ? roundToTwoDecimals(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

      // 4. VehicleMetrics
      let metricsWhere = { truck_ID: truckId };
      let metrics = await db.run(
        SELECT.from('tracker.VehicleMetrics')
          .where(metricsWhere)
          .columns('fuelLitres', 'tyreFL', 'tyreFR', 'tyreRL', 'tyreRR', 'engineTempC', 'odometerKm', 'capturedAt')
      );
      if (from) metrics = metrics.filter(m => m.capturedAt >= from);
      if (to)   metrics = metrics.filter(m => m.capturedAt <= to);

      const fuelReadings = (metrics || []).map(m => m.fuelLitres).filter(v => v != null);
      const tyreReadings   = metrics.flatMap(m => [m.tyreFL, m.tyreFR, m.tyreRL, m.tyreRR]).filter(v => v != null);
      const totalFuelLitres = fuelReadings.length ? roundToTwoDecimals(fuelReadings.reduce((a, b) => a + b, 0)) : 0;
      const avgTyrePressure = tyreReadings.length
        ? roundToTwoDecimals(tyreReadings.reduce((a, b) => a + b, 0) / tyreReadings.length)
        : null;
      const minTyrePressure = tyreReadings.length ? Math.min(...tyreReadings) : null;

      // 5. Odometer delta
      const odomReadings = metrics.map(m => m.odometerKm).filter(v => v != null).sort((a, b) => a - b);
      const odometerDeltaKm = odomReadings.length >= 2
        ? roundToTwoDecimals(odomReadings[odomReadings.length - 1] - odomReadings[0])
        : null;

      // 6. Checkpoint compliance
      let checkpointReadings = [];
      if (freightOrders.length > 0) {
        const foIds = freightOrders.map(o => o.ID);
        checkpointReadings = await db.run(
          SELECT.from('tracker.CheckpointReadings')
            .where({ freightOrder_ID: { in: foIds } })
            .columns('freightOrder_ID', 'checkpointNo')
        );
      }
      const totalRequired  = freightOrders.reduce((sum, o) => sum + (o.checkpointCount || 0), 0);
      const totalSubmitted = checkpointReadings.length;
      const checkpointCompliancePct = totalRequired > 0
        ? roundToTwoDecimals((totalSubmitted / totalRequired) * 100)
        : null;

      // 7. Alerts
      let alerts = await db.run(
        SELECT.from('tracker.AlertEvents')
          .where({ truck_ID: truckId })
          .columns('severity', 'metricType', 'firedAt', 'isRead')
      );
      if (from) alerts = alerts.filter(a => a.firedAt >= from);
      if (to)   alerts = alerts.filter(a => a.firedAt <= to);
      const criticalAlerts = alerts.filter(a => a.severity === 'CRITICAL').length;
      const warningAlerts  = alerts.filter(a => a.severity === 'WARNING').length;

      return {
        truckId,
        totalTrips:              trips.length,
        completedTrips:          completedTrips.length,
        completionRatePct:       trips.length > 0 ? roundToTwoDecimals((completedTrips.length / trips.length) * 100) : 0,
        avgTripDurationMs,
        totalFuelLitres,
        avgTyrePressure,
        minTyrePressure,
        odometerDeltaKm,
        totalMetricReadings:     metrics.length,
        checkpointRequired:      totalRequired,
        checkpointSubmitted:     totalSubmitted,
        checkpointCompliancePct,
        criticalAlerts,
        warningAlerts,
        totalAlerts:             alerts.length,
        freightOrderCount:       freightOrders.length
      };
    };

    const buildFleetReport = async (db, admin, from, to) => {
      const trucks = await db.run(SELECT.from('tracker.Trucks').where({ admin_ID: admin.ID, status: { '!=': 'DEACTIVATED' } }).columns('ID','truckNumber','model','registrationNumber','status','assignedDriver_ID'));
      if (!trucks || trucks.length === 0) return { trucks: [], totals: {}, totalTrucks: 0 };

      const reports = await Promise.all(trucks.map(t => buildTruckReport(db, t.ID, from, to)));

      const assignedDriverIds = Array.from(new Set(trucks.map(t => t.assignedDriver_ID).filter(Boolean)));
      const drivers = assignedDriverIds.length ? await db.run(SELECT.from('tracker.Drivers').where({ ID: { in: assignedDriverIds } }).columns('ID','name')) : [];
      const driverMap = {}; (drivers || []).forEach(d => { driverMap[d.ID] = d; });

      const totals = {
        totalTrips: 0,
        completedTrips: 0,
        totalFuelLitres: 0,
        odometerDeltaKm: 0,
        criticalAlerts: 0,
        warningAlerts: 0,
        checkpointRequired: 0,
        checkpointSubmitted: 0
      };

      let completionRates = [];

      reports.forEach(r => {
        totals.totalTrips += Number(r.totalTrips || 0);
        totals.completedTrips += Number(r.completedTrips || 0);
        totals.totalFuelLitres += Number(r.totalFuelLitres || 0);
        totals.odometerDeltaKm += Number(r.odometerDeltaKm || 0) || 0;
        totals.criticalAlerts += Number(r.criticalAlerts || 0);
        totals.warningAlerts += Number(r.warningAlerts || 0);
        totals.checkpointRequired += Number(r.checkpointRequired || 0);
        totals.checkpointSubmitted += Number(r.checkpointSubmitted || 0);
        completionRates.push(Number(r.completionRatePct || 0));
      });

      const totalsOut = {
        totalTrips: totals.totalTrips,
        completedTrips: totals.completedTrips,
        totalFuelLitres: roundToTwoDecimals(totals.totalFuelLitres),
        odometerDeltaKm: roundToTwoDecimals(totals.odometerDeltaKm),
        criticalAlerts: totals.criticalAlerts,
        warningAlerts: totals.warningAlerts,
        checkpointRequired: totals.checkpointRequired,
        checkpointSubmitted: totals.checkpointSubmitted,
        checkpointCompliancePct: totals.checkpointRequired > 0 ? roundToTwoDecimals((totals.checkpointSubmitted / totals.checkpointRequired) * 100) : null,
        avgCompletionRatePct: completionRates.length ? roundToTwoDecimals(completionRates.reduce((a,b)=>a+b,0)/completionRates.length) : 0
      };

      return { trucks, reports, totals: totalsOut, totalTrucks: trucks.length, driverMap };
    };

    // Endpoint 1: Per-truck report
    app.get('/tracker/reports/truck/:id', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        const id = req.params.id;
        const truck = await db.run(SELECT.one.from('tracker.Trucks').where({ ID: id }));
        if (!truck) return res.status(404).json({ error: 'Truck not found' });
        if (truck.admin_ID !== admin.ID) return res.status(403).json({ error: 'Forbidden' });

        let from = null, to = null;
        try {
          const range = parseDateRange(req.query || {});
          from = range.from; to = range.to;
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }

        const report = await buildTruckReport(db, id, from, to);

        let assignedDriverName = null;
        if (truck.assignedDriver_ID) {
          const drv = await db.run(SELECT.one.from('tracker.Drivers').where({ ID: truck.assignedDriver_ID }).columns('name'));
          assignedDriverName = drv && drv.name ? drv.name : null;
        }

        return res.json({
          generatedAt: nowISO(),
          dateRange: { from, to },
          truck: { id: truck.ID, truckNumber: truck.truckNumber, model: truck.model, registrationNumber: truck.registrationNumber, fuelType: truck.fuelType, status: truck.status, assignedDriverName },
          report
        });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 2: Fleet report
    app.get('/tracker/reports/fleet', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        let from = null, to = null;
        try {
          const range = parseDateRange(req.query || {});
          from = range.from; to = range.to;
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }

        const fleet = await buildFleetReport(db, admin, from, to);
        if (!fleet.trucks || fleet.trucks.length === 0) {
          return res.json({ generatedAt: nowISO(), dateRange: { from, to }, totalTrucks: 0, trucks: [], totals: {} });
        }

        const { trucks, reports, totals, driverMap } = fleet;

        const trucksOut = trucks.map((t, i) => ({
          ...reports[i],
          truckNumber: t.truckNumber,
          model: t.model,
          registrationNumber: t.registrationNumber,
          status: t.status,
          assignedDriverName: driverMap[t.assignedDriver_ID] ? driverMap[t.assignedDriver_ID].name : null
        }));

        return res.json({ generatedAt: nowISO(), dateRange: { from, to }, totalTrucks: trucks.length, totals, trucks: trucksOut });
      } catch (err) {
        next(err);
      }
    });

    // Endpoint 3: Fleet export (Excel)
    app.get('/tracker/reports/fleet/export', requireAdminAuth, async (req, res, next) => {
      try {
        const db = await cds.connect.to('db');
        const admin = await getAdminFromReq(db, req);
        if (!admin) return res.status(401).json({ error: 'Unauthorized' });

        let from = null, to = null;
        try {
          const range = parseDateRange(req.query || {});
          from = range.from; to = range.to;
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }

        const fleet = await buildFleetReport(db, admin, from, to);
        const { trucks, reports, totals, driverMap } = fleet;

        const workbook = new ExcelJS.Workbook();
        const summarySheet = workbook.addWorksheet('Fleet Summary');
        summarySheet.columns = [ { width: 30 }, { width: 20 } ];
        summarySheet.addRow(['Generated At', 'Date From', 'Date To']);
        summarySheet.addRow([nowISO(), from || '', to || '']);
        summarySheet.addRow([]);
        summarySheet.addRow(['Metric', 'Value']);
        Object.entries(totals).forEach(([k,v]) => {
          summarySheet.addRow([k, v]);
        });

        const truckSheet = workbook.addWorksheet('Per Truck Report');
        truckSheet.views = [{ state: 'frozen', ySplit: 1 }];
        const header = ['Truck #', 'Model', 'Reg #', 'Driver', 'Status', 'Total Trips', 'Completed', 'Completion %', 'Fuel Litres', 'Odometer km', 'Avg Tyre PSI', 'Min Tyre PSI', 'Checkpoint %', 'Critical Alerts', 'Warning Alerts'];
        truckSheet.addRow(header);
        const headerRow = truckSheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern:'solid', fgColor:{argb:'FF1F497D'} };

        for (let i = 0; i < trucks.length; i++) {
          const t = trucks[i];
          const r = reports[i];
          const row = [t.truckNumber, t.model, t.registrationNumber, driverMap[t.assignedDriver_ID] ? driverMap[t.assignedDriver_ID].name : '', t.status, r.totalTrips, r.completedTrips, r.completionRatePct, r.totalFuelLitres, r.odometerDeltaKm, r.avgTyrePressure, r.minTyrePressure, r.checkpointCompliancePct, r.criticalAlerts, r.warningAlerts];
          const newRow = truckSheet.addRow(row);
          // apply number formats
          [8,9,10,11,12].forEach(idx => {
            const cell = newRow.getCell(idx);
            cell.numFmt = '0.00';
          });
          // conditional fill for Min Tyre PSI (column 12)
          const minTyre = r.minTyrePressure;
          if (minTyre != null && Number(minTyre) < 0) {
            newRow.getCell(12).fill = { type: 'pattern', pattern:'solid', fgColor:{argb:'FFFFCCCC'} };
          }
        }

        // set column widths
        truckSheet.columns.forEach(c => { c.width = 18; });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="fleet-report-${new Date().toISOString().slice(0,10)}.xlsx"`);

        await workbook.xlsx.write(res);
        res.end();
      } catch (err) {
        next(err);
      }
    });

  });
