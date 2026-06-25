sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  const LEAFLET_JS_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
  const LEAFLET_CSS_URL = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
  const LEAFLET_JS_INTEGRITY = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
  const LEAFLET_CSS_INTEGRITY = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";

  return UIComponent.extend("com.locationtracker.locationtracker.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);
      this._loadLeaflet();

      this.setModel(new JSONModel({
        sCurrentView: "loading",
        role: null,
        loginTab: "driver",
        busy: false,
        authError: "",
        adminProfile: null,
        driverProfile: null,
        driverCsrfToken: null,
        driverLogin: {
          email: "",
          password: ""
        },
        drivers: [],
        driverSummary: { total: 0, active: 0, onTrip: 0, inactive: 0 },
        pendingDrivers: [],
        pendingDriverCount: 0,
        rejectReason: "",
        selectedPendingDriverId: null,
        selectedTruck: null,
        selectedTruckId: null,
        approvedDrivers: [],
        truckMetrics: [],
        truckMetricsSummary: {},
        truckThresholds: [],
        truckFreightHistory: [],
        freightOrders: [],
        freightOrderCount: 0,
        freightOrderCounts: {
          total: 0,
          planned: 0,
          dispatched: 0,
          delivered: 0,
          cancelled: 0
        },
        selectedFreightOrder: null,
        selectedFreightOrderId: null,
        freightOrderCheckpoints: {
          readings: [],
          submitted: 0,
          isComplete: false
        },
        freightOrderStatusFilter: "ALL",
        newFreightOrder: {
          orderNumber: "",
          truck_ID: null,
          driver_ID: null,
          origin: "",
          destination: "",
          plannedDeparture: null,
          plannedArrival: null,
          checkpointCount: 0
        },
        gatePasses: [],
        gatePassCount: 0,
        gatePassCounts: {
          total: 0,
          out: 0,
          in: 0,
          pending: 0
        },
        gatePassFilter: {
          truckId: null,
          freightOrderId: null
        },
        newGatePass: {
          freightOrder_ID: null,
          truck_ID: null,
          driver_ID: null,
          gateOfficer: "",
          direction: "OUT",
          remarks: "",
          truckDisplay: "",
          driverDisplay: ""
        },
        fleetSummary: {
          total: 0,
          active: 0,
          idle: 0,
          deactivated: 0
        },
        trucks: [],
        addTruck: {
          truckNumber: "",
          model: "",
          registrationNumber: "",
          fuelType: "Diesel",
          status: "IDLE",
          assignedDriver_ID: null
        },
        assignDriver: {
          selectedDriverId: null
        },
        thresholds: {
          FUEL_LEVEL: {
            warningAt: 20,
            criticalAt: 10
          },
          TYRE_PRESSURE: {
            warningAt: 30,
            criticalAt: 26
          },
          ENGINE_TEMP: {
            warningAt: 90,
            criticalAt: 105
          }
        },
        tracking: false,
        currentTrip: null,
        totalPoints: 0,
        lastPoint: null,
        statusText: "Tracking is idle",
        permissionText: "Awaiting browser location permission",
        metrics: {
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
        }
      }), "appState");
    },

    getLeafletReady: function () {
      return this._leafletPromise || Promise.resolve();
    },

    _loadLeaflet: function () {
      if (this._leafletPromise) {
        return this._leafletPromise;
      }

      const ensureLeafletStyles = function () {
        if (!document.querySelector(`link[href="${LEAFLET_CSS_URL}"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = LEAFLET_CSS_URL;
          link.integrity = LEAFLET_CSS_INTEGRITY;
          link.crossOrigin = "";
          document.head.appendChild(link);
        }
      };

      ensureLeafletStyles();

      if (window.L) {
        this._leafletPromise = Promise.resolve();
        return this._leafletPromise;
      }

      this._leafletPromise = new Promise(function (resolve, reject) {
        const existingScript = document.querySelector(`script[src="${LEAFLET_JS_URL}"]`);
        if (existingScript) {
          if (window.L) {
            resolve();
            return;
          }
          existingScript.addEventListener("load", resolve);
          existingScript.addEventListener("error", function () {
            reject(new Error("Leaflet failed to load"));
          });
          return;
        }

        const script = document.createElement("script");
        script.src = LEAFLET_JS_URL;
        script.integrity = LEAFLET_JS_INTEGRITY;
        script.crossOrigin = "";
        script.onload = resolve;
        script.onerror = function () {
          reject(new Error("Leaflet failed to load"));
        };
        document.head.appendChild(script);
      });

      return this._leafletPromise;
    }
  });
});
