sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, MessageBox, MessageToast) {
  "use strict";
  const MAX_LATENCY_SAMPLES = 200;

  return Controller.extend("com.locationtracker.locationtracker.controller.App", {
    onInit: function () {
      this._watchId = null;
      this._map = null;
      this._polyline = null;
      this._marker = null;
      this._points = [];
      this._clientUpdateLatencyMs = [];
      this._viewModel = this.getOwnerComponent().getModel("view");

      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._ensureMap();
        }.bind(this)
      });

      this._restoreDriverSession();
    },

    onAfterRendering: function () {
      this._ensureMap();
    },

    onStartTracking: async function () {
      if (!this._viewModel.getProperty("/driverAuthenticated")) {
        MessageBox.error("Please log in as a driver first.");
        return;
      }

      if (!navigator.geolocation) {
        MessageBox.error("This browser does not support geolocation.");
        return;
      }

      try {
        let trip = this._viewModel.getProperty("/currentTrip");

        if (!trip || trip.status !== "ACTIVE") {
          trip = await this._post("/drivers/startTrip", {
            title: "Trip " + new Date().toLocaleString()
          });
          this._viewModel.setProperty("/currentTrip", trip);
          this._points = [];
          this._syncPolyline();
        }

        this._viewModel.setProperty("/tracking", true);
        this._viewModel.setProperty("/statusText", "Tracking is live");
        this._viewModel.setProperty("/permissionText", "Location access granted");

        this._watchId = navigator.geolocation.watchPosition(
          this._onPositionSuccess.bind(this),
          this._onPositionError.bind(this),
          {
            enableHighAccuracy: true,
            maximumAge: 2000,
            timeout: 10000
          }
        );

        await this.onRefreshPath();
        await this._refreshMetrics();
        MessageToast.show("Trip started");
      } catch (error) {
        MessageBox.error(error.message || "Unable to start tracking.");
      }
    },

    onStopTracking: async function () {
      if (!this._viewModel.getProperty("/driverAuthenticated")) {
        MessageBox.error("Please log in as a driver first.");
        return;
      }

      const trip = this._viewModel.getProperty("/currentTrip");
      if (!trip) {
        return;
      }

      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      try {
        const stoppedTrip = await this._post("/drivers/stopTrip", { tripId: trip.ID });
        this._viewModel.setProperty("/currentTrip", stoppedTrip);
        this._viewModel.setProperty("/tracking", false);
        this._viewModel.setProperty("/statusText", "Tracking stopped");
        await this._refreshMetrics();
        MessageToast.show("Trip stopped");
      } catch (error) {
        MessageBox.error(error.message || "Unable to stop tracking.");
      }
    },

    onRefreshPath: async function () {
      if (!this._viewModel.getProperty("/driverAuthenticated")) {
        return;
      }

      const trip = this._viewModel.getProperty("/currentTrip");
      this._ensureMap();

      if (!trip || !trip.ID) {
        if (this._map) {
          this._map.invalidateSize();
        }
        return;
      }

      try {
        const points = await this._get("/drivers/path/" + trip.ID);
        this._points = (points.value || []).map(function (point) {
          return [Number(point.latitude), Number(point.longitude)];
        });

        const lastPoint = points.value && points.value.length ? points.value[points.value.length - 1] : null;
        this._viewModel.setProperty("/lastPoint", lastPoint);
        this._viewModel.setProperty("/totalPoints", this._points.length);
        this._syncPolyline();
        await this._refreshMetrics();
      } catch (error) {
        MessageBox.error(error.message || "Unable to refresh the path.");
      }
    },

    _loadActiveTrip: async function () {
      try {
        const trip = await this._get("/drivers/activeTrip");
        if (trip && trip.ID) {
          this._viewModel.setProperty("/currentTrip", trip);
          this._viewModel.setProperty("/statusText", "Active trip restored");
          await this.onRefreshPath();
        } else {
          this._viewModel.setProperty("/statusText", "Backend reachable, no active trip loaded");
        }
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Backend reachable, no active trip loaded");
      }
    },

    _onPositionSuccess: async function (position) {
  const trip = this._viewModel.getProperty("/currentTrip");
  if (!trip || !trip.ID) {
    return;
  }

  const payload = {
    tripId: trip.ID,
    latitude: Number(position.coords.latitude.toFixed(6)),
    longitude: Number(position.coords.longitude.toFixed(6)),
    accuracy: position.coords.accuracy != null ? Number(position.coords.accuracy.toFixed(2)) : null,
    altitude: position.coords.altitude != null ? Number(position.coords.altitude.toFixed(2)) : null,
    speed: position.coords.speed != null ? Number(position.coords.speed.toFixed(2)) : null,
    heading: position.coords.heading != null ? Number(position.coords.heading.toFixed(2)) : null,
    recordedAt: new Date(position.timestamp).toISOString(),
    source: "browser-geolocation"
  };

  try {
    if (!this._viewModel.getProperty("/driverAuthenticated")) {
      return;
    }

    const clientUpdateStart = this._getHighResTime();
    const point = await this._post("/drivers/recordLocation", payload);
    const latLng = [Number(point.latitude), Number(point.longitude)];
    this._points.push(latLng);
    this._viewModel.setProperty("/lastPoint", point);
    this._viewModel.setProperty("/totalPoints", this._points.length);
    this._viewModel.setProperty("/statusText", "Tracking is live");
    this._syncPolyline(latLng);
    const clientUpdateEnd = this._getHighResTime();
    this._recordClientUpdateLatency(clientUpdateEnd - clientUpdateStart);
    this._refreshMetrics();
  } catch (error) {
    MessageBox.error(error.message || "Unable to persist the current position.");
  }
},


    _onPositionError: function (error) {
      this._viewModel.setProperty("/permissionText", error.message || "Location permission denied");
      this._viewModel.setProperty("/tracking", false);

      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }
    },

    _ensureMap: function () {
      const mapContainer = document.getElementById("tracker-map");

      if (!mapContainer) {
        this._viewModel.setProperty("/statusText", "Map container not found");
        return;
      }

      if (!window.L) {
        this._viewModel.setProperty("/statusText", "Leaflet failed to load");
        return;
      }

      if (this._map) {
        setTimeout(function () {
          this._map.invalidateSize();
        }.bind(this), 150);
        return;
      }

      try {
        this._map = window.L.map(mapContainer, {
          zoomControl: true
        }).setView([20.5937, 78.9629], 5);

        window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "&copy; OpenStreetMap contributors"
        }).addTo(this._map);

        this._polyline = window.L.polyline([], {
          color: "#0a6ed1",
          weight: 5
        }).addTo(this._map);

        this._viewModel.setProperty("/statusText", "Map ready");

        setTimeout(function () {
          if (this._map) {
            this._map.invalidateSize();
          }
        }.bind(this), 250);
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Map initialization failed");
      }
    },

    _syncPolyline: function (latestPoint) {
      this._ensureMap();

      if (!this._map || !this._polyline) {
        return;
      }

      this._polyline.setLatLngs(this._points);

      if (latestPoint) {
        if (!this._marker) {
          this._marker = window.L.marker(latestPoint).addTo(this._map);
        } else {
          this._marker.setLatLng(latestPoint);
        }

        this._map.setView(latestPoint, 18);
        return;
      }

      if (this._points.length > 1) {
        this._map.fitBounds(this._polyline.getBounds(), { padding: [20, 20] });
      } else if (this._points.length === 1) {
        if (!this._marker) {
          this._marker = window.L.marker(this._points[0]).addTo(this._map);
        } else {
          this._marker.setLatLng(this._points[0]);
        }

        this._map.setView(this._points[0], 18);
      }

      setTimeout(function () {
        if (this._map) {
          this._map.invalidateSize();
        }
      }.bind(this), 150);
    },

    _get: async function (url) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json"
        }
      });

      if (!response.ok) {
        throw new Error(await this._extractError(response));
      }

      return response.json();
    },

    _post: async function (url, payload) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json"
      };
      const csrfToken = this._viewModel.getProperty("/driverCsrfToken");
      if (csrfToken) {
        headers["X-Driver-CSRF-Token"] = csrfToken;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(await this._extractError(response));
      }

      return response.json();
    },

    _extractError: async function (response) {
      try {
        const data = await response.json();
        return data.error && data.error.message ? data.error.message : response.statusText;
      } catch (error) {
        return response.statusText || "Unknown request error";
      }
    },

    _refreshMetrics: async function () {
      try {
        if (!this._viewModel.getProperty("/driverAuthenticated")) {
          this._viewModel.setProperty("/metrics", Object.assign({}, this._viewModel.getProperty("/metrics"), {
            generatedAt: null,
            totalTrips: 0,
            completedTrips: 0,
            completionRate: 0,
            avgPointsPerTrip: 0,
            avgGpsAccuracy: 0,
            avgSessionDurationMs: 0,
            ingestSuccessRate: 0,
            avgIngestLatencyMs: 0,
            avgClientUpdateLatencyMs: 0,
            latestClientUpdateLatencyMs: 0
          }));
          return;
        }

        const metrics = await this._get("/drivers/metrics");
        const averageClientLatency = this._clientUpdateLatencyMs.length
          ? this._clientUpdateLatencyMs.reduce(function (sum, latencyMs) { return sum + latencyMs; }, 0) / this._clientUpdateLatencyMs.length
          : 0;

        const latestLatency = this._clientUpdateLatencyMs.length
          ? this._clientUpdateLatencyMs[this._clientUpdateLatencyMs.length - 1]
          : 0;

        this._viewModel.setProperty("/metrics", Object.assign({}, metrics, {
          avgClientUpdateLatencyMs: Number(averageClientLatency.toFixed(2)),
          latestClientUpdateLatencyMs: Number(latestLatency.toFixed(2))
        }));
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Metrics unavailable");
      }
    },

    _recordClientUpdateLatency: function (latencyMs) {
      if (!Number.isFinite(latencyMs) || latencyMs < 0) {
        return;
      }

      this._clientUpdateLatencyMs.push(latencyMs);
      if (this._clientUpdateLatencyMs.length > MAX_LATENCY_SAMPLES) {
        this._clientUpdateLatencyMs.shift();
      }
    },

    _getHighResTime: function () {
      return window.performance && window.performance.now ? window.performance.now() : Date.now();
    },

    onDriverLogin: async function () {
      const credentials = this._viewModel.getProperty("/driverLogin") || {};

      try {
        const response = await this._post("/drivers/login", {
          email: credentials.email,
          password: credentials.password
        });

        this._viewModel.setProperty("/driverAuthenticated", true);
        this._viewModel.setProperty("/driverProfile", response.driver || null);
        this._viewModel.setProperty("/driverCsrfToken", response.csrfToken || null);
        this._viewModel.setProperty("/driverLogin/password", "");
        this._viewModel.setProperty("/statusText", "Driver login successful");

        await this._loadActiveTrip();
        await this._refreshMetrics();
        MessageToast.show("Logged in as driver");
      } catch (error) {
        this._clearDriverSessionData();
        MessageBox.error(error.message || "Driver login failed.");
      }
    },

    onDriverLogout: async function () {
      try {
        await this._post("/drivers/logout", {});
      } catch (error) {
        // Continue logout cleanup on client even if session is already expired.
      }

      this._clearDriverSessionData();
      MessageToast.show("Logged out");
    },

    _restoreDriverSession: async function () {
      try {
        const response = await this._get("/drivers/me");
        this._viewModel.setProperty("/driverAuthenticated", true);
        this._viewModel.setProperty("/driverProfile", response.driver || null);
        this._viewModel.setProperty("/driverCsrfToken", response.csrfToken || null);
        this._viewModel.setProperty("/statusText", "Driver session restored");
        await this._loadActiveTrip();
        await this._refreshMetrics();
      } catch (error) {
        this._clearDriverSessionData();
        this._viewModel.setProperty("/statusText", "Please log in as driver");
      }
    },

    _clearDriverSessionData: function () {
      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      this._viewModel.setProperty("/driverAuthenticated", false);
      this._viewModel.setProperty("/driverProfile", null);
      this._viewModel.setProperty("/driverCsrfToken", null);
      this._viewModel.setProperty("/tracking", false);
      this._viewModel.setProperty("/currentTrip", null);
      this._viewModel.setProperty("/lastPoint", null);
      this._viewModel.setProperty("/totalPoints", 0);
      this._viewModel.setProperty("/permissionText", "Awaiting browser location permission");
      this._clientUpdateLatencyMs = [];
      this._points = [];
      this._syncPolyline();
      this._refreshMetrics();
    }
  });
});
