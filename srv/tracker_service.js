const cds = require("@sap/cds");
const bcrypt = require("bcrypt");
const { SELECT, INSERT, UPDATE } = cds.ql;
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;
const PASSWORD_SALT_ROUNDS = 10;

module.exports = cds.service.impl(function () {
  const { Admins, Drivers, Trips, LocationPoints, MetricSnapshots } = this.entities;
  const operationMetrics = {
    startTrip: createMetricBucket(),
    stopTrip: createMetricBucket(),
    recordLocation: createMetricBucket()
  };
  let lastSnapshotAt = null;

  const withOperationMetrics = async (operationName, fn) => {
    const bucket = operationMetrics[operationName];
    const startedAt = Date.now();

    bucket.attempts += 1;

    try {
      const result = await fn();
      bucket.success += 1;
      return result;
    } catch (error) {
      bucket.failure += 1;
      throw error;
    } finally {
      bucket.totalLatencyMs += Date.now() - startedAt;
    }
  };

  const nowISO = () => new Date().toISOString();
  const userId = (req) => req.user?.id;
  const userName = (req) => req.user?.attr?.given_name || req.user?.attr?.family_name || userId(req);
  const isAdmin = (req) => req.user?.is("FleetAdmin");
  const isDriver = (req) => req.user?.is("Driver");

  const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

  const getAdminByEmail = (email) =>
    SELECT.one.from(Admins).where({ email: normalizeEmail(email) });

  const getDriverByEmail = (email) =>
    SELECT.one.from(Drivers).where({ email: normalizeEmail(email) });

  const getTripById = (id) =>
    SELECT.one.from(Trips).where({ ID: id });

  const ensureAdminProfile = async (req) => {
    if (!isAdmin(req)) return null;

    const email = normalizeEmail(userId(req));
    let admin = await getAdminByEmail(email);
    if (admin) return admin;

    admin = {
      ID: cds.utils.uuid(),
      name: userName(req),
      email
    };

    await INSERT.into(Admins).entries(admin);
    return admin;
  };

  const requireDriverProfile = async (req) => {
    const driver = await getDriverByEmail(userId(req));
    if (!driver || driver.status !== "ACTIVE") {
      return req.reject(403, "No active driver profile is assigned to this login");
    }
    return driver;
  };

  const getActiveTrip = (driverId) =>
    SELECT.one.from(Trips)
      .where({ status: "ACTIVE", driver_ID: driverId })
      .orderBy("startedAt desc");

  const rejectIfNotTripDriver = async (req, tripId) => {
    const driver = await requireDriverProfile(req);
    if (!driver) return null;

    const trip = await getTripById(tripId);
    if (!trip) return req.reject(404, "Trip not found");
    if (trip.driver_ID !== driver.ID) {
      return req.reject(403, "Drivers can only access their own trips");
    }

    return { trip, driver };
  };

  this.before("READ", Admins, (req) => {
    req.query.where({ email: normalizeEmail(userId(req)) });
  });

  this.before("READ", Drivers, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ email: normalizeEmail(userId(req)) });
  });

  this.before("READ", Trips, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "driver.admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ "driver.email": normalizeEmail(userId(req)) });
  });

  this.before("READ", LocationPoints, (req) => {
    if (isAdmin(req)) {
      req.query.where({ "trip.driver.admin.email": normalizeEmail(userId(req)) });
      return;
    }

    req.query.where({ "trip.driver.email": normalizeEmail(userId(req)) });
  });

  this.on("me", async (req) => {
    const admin = await ensureAdminProfile(req);
    const driver = isDriver(req) ? await getDriverByEmail(userId(req)) : null;

    return {
      email: normalizeEmail(userId(req)),
      name: userName(req),
      isAdmin: isAdmin(req),
      isDriver: Boolean(driver && driver.status === "ACTIVE"),
      adminId: admin?.ID || null,
      driverId: driver?.ID || null
    };
  });

  this.on("createDriver", async (req) => {
    const admin = await ensureAdminProfile(req);
    if (!admin) return req.reject(403, "Only fleet admins can create drivers");

    const email = normalizeEmail(req.data.email);
    const password = String(req.data.password || "");
    if (!email) return req.reject(400, "Driver email is required");
    if (!password || password.length < 8) {
      return req.reject(400, "Driver password is required and must be at least 8 characters");
    }

    const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);

    const existingDriver = await getDriverByEmail(email);
    if (existingDriver && existingDriver.admin_ID !== admin.ID) {
      return req.reject(409, "A driver with this email is already assigned to another admin");
    }

    if (existingDriver) {
      await UPDATE(Drivers)
        .set({
          name: req.data.name || existingDriver.name,
          phone: req.data.phone || existingDriver.phone,
          passwordHash,
          temporaryPassword: true,
          status: "ACTIVE"
        })
        .where({ ID: existingDriver.ID });
      return SELECT.one.from(Drivers).where({ ID: existingDriver.ID });
    }

    const entry = {
      ID: cds.utils.uuid(),
      name: req.data.name || email,
      email,
      phone: req.data.phone || null,
      passwordHash,
      temporaryPassword: true,
      status: "ACTIVE",
      admin_ID: admin.ID
    };

    await INSERT.into(Drivers).entries(entry);
    return entry;
  });

  this.on("startTrip", async (req) => {
    return withOperationMetrics("startTrip", async () => {
      const driver = await requireDriverProfile(req);
      if (!driver) return null;

      const activeTrip = await getActiveTrip(driver.ID);
      if (activeTrip) return activeTrip;

      const entry = {
        ID: cds.utils.uuid(),
        title: req.data.title || `Trip ${nowISO()}`,
        driver_ID: driver.ID,
        startedAt: nowISO(),
        status: "ACTIVE"
      };

      await INSERT.into(Trips).entries(entry);
      return entry;
    });
  });

  this.on("stopTrip", async (req) => {
    return withOperationMetrics("stopTrip", async () => {
      const { tripId } = req.data;
      if (!tripId) {
        return req.reject(400, "tripId is required");
      }

      const result = await rejectIfNotTripDriver(req, tripId);
      if (!result) return null;

      await UPDATE(Trips)
        .set({ status: "COMPLETED", endedAt: nowISO() })
        .where({ ID: tripId });

      const stoppedTrip = await getTripById(tripId);
      await captureSnapshotIfDue(true);
      return stoppedTrip;
    });
  });

  this.on("recordLocation", async (req) => {
    return withOperationMetrics("recordLocation", async () => {
      const { tripId, latitude, longitude } = req.data;
      if (!tripId) {
        return req.reject(400, "tripId is required");
      }
      if (latitude == null || longitude == null) {
        return req.reject(400, "latitude and longitude are required");
      }

      const result = await rejectIfNotTripDriver(req, tripId);
      if (!result) return null;
      if (result.trip.status !== "ACTIVE") {
        return req.reject(400, "Trip is not active");
      }

      const payload = {
        ID: cds.utils.uuid(),
        trip_ID: tripId,
        latitude,
        longitude,
        accuracy: req.data.accuracy ?? null,
        altitude: req.data.altitude ?? null,
        speed: req.data.speed ?? null,
        heading: req.data.heading ?? null,
        recordedAt: req.data.recordedAt || nowISO(),
        source: req.data.source || "browser-geolocation"
      };

      await INSERT.into(LocationPoints).entries(payload);
      return payload;
    });
  });

  this.on("activeTrip", async (req) => {
    const driver = await requireDriverProfile(req);
    if (!driver) return null;
    return (await getActiveTrip(driver.ID)) || null;
  });

  this.on("metrics", async () => {
    await captureSnapshotIfDue(false);
    return readCurrentMetrics();
  });

  const captureSnapshotIfDue = async (forceSnapshot) => {
    const now = Date.now();
    const shouldCapture = forceSnapshot || !lastSnapshotAt || now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS;

    if (!shouldCapture) {
      return null;
    }

    const metrics = await readCurrentMetrics();
    const snapshotEntry = {
      capturedAt: metrics.generatedAt,
      totalTrips: metrics.totalTrips,
      completedTrips: metrics.completedTrips,
      completionRate: metrics.completionRate,
      totalPoints: metrics.totalPoints,
      avgPointsPerTrip: metrics.avgPointsPerTrip,
      avgGpsAccuracy: metrics.avgGpsAccuracy,
      avgSessionDurationMs: metrics.avgSessionDurationMs,
      ingestSuccessRate: metrics.ingestSuccessRate,
      avgIngestLatencyMs: metrics.avgIngestLatencyMs
    };

    await INSERT.into(MetricSnapshots).entries(snapshotEntry);
    lastSnapshotAt = now;
    return snapshotEntry;
  };

  const readCurrentMetrics = async () => {
    const [tripCountRow] = await SELECT.from(Trips).columns("count(1) as count");
    const [completedTripCountRow] = await SELECT.from(Trips).where({ status: "COMPLETED" }).columns("count(1) as count");
    const [pointCountRow] = await SELECT.from(LocationPoints).columns("count(1) as count");
    const [accuracyAverageRow] = await SELECT.from(LocationPoints)
      .where({ accuracy: { "!=": null } })
      .columns("avg(accuracy) as avgAccuracy");

    const completedTrips = await SELECT.from(Trips)
      .where({ status: "COMPLETED" })
      .columns("startedAt", "endedAt");

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

    const ingestAttempts = operationMetrics.recordLocation.attempts;
    const ingestSuccess = operationMetrics.recordLocation.success;
    const ingestFailure = operationMetrics.recordLocation.failure;
    const ingestSuccessRate = ingestAttempts ? roundToTwoDecimals((ingestSuccess / ingestAttempts) * 100) : 0;
    const avgIngestLatencyMs = ingestAttempts
      ? roundToTwoDecimals(operationMetrics.recordLocation.totalLatencyMs / ingestAttempts)
      : 0;

    return {
      generatedAt: new Date().toISOString(),
      totalTrips,
      completedTrips: totalCompletedTrips,
      completionRate,
      totalPoints,
      avgPointsPerTrip,
      avgGpsAccuracy,
      avgSessionDurationMs,
      ingestAttempts,
      ingestSuccess,
      ingestFailure,
      ingestSuccessRate,
      avgIngestLatencyMs
    };
  };
});

function createMetricBucket() {
  return {
    attempts: 0,
    success: 0,
    failure: 0,
    totalLatencyMs: 0
  };
}

function roundToTwoDecimals(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
