sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  return UIComponent.extend("com.locationtracker.locationtracker.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

        this.setModel(new JSONModel({
          busy: false,
          driverAuthenticated: false,
          driverProfile: null,
          driverCsrfToken: null,
          driverLogin: {
            email: "",
            password: ""
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
      }), "view");

    }
  });
});
