sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageToast"
], function (Controller, Fragment, MessageBox, MessageToast) {
  "use strict";

  const MAX_LATENCY_SAMPLES = 200;
  const DEV_ROLE_KEY = "devRole";

  return Controller.extend("com.locationtracker.locationtracker.controller.App", {
    onInit: function () {
      this._watchId = null;
      this._map = null;
      this._polyline = null;
      this._marker = null;
      this._points = [];
      this._clientUpdateLatencyMs = [];
      this._viewModel = this.getOwnerComponent().getModel("appState");
      this._adminCsrfToken = null;
      this._allDrivers = null;
      this._allTrucks = null;
      this._addDriverDialog = null;
      this._addTruckDialog = null;
      this._assignDriverDialog = null;
      this._freightOrderDialog = null;
      this._checkpointsDialog = null;
      this._gatePassDialog = null;
      this._leafletLoadPending = false;

      const mapContainer = this.byId("trackerMapContainer");
      if (mapContainer) {
        mapContainer.addEventDelegate({
          onAfterRendering: function () {
            this._ensureMap();
          }.bind(this)
        });
      }

      const mapHost = this.byId("trackerMap");
      if (mapHost) {
        mapHost.addEventDelegate({
          onAfterRendering: function () {
            this._syncPolyline();
          }.bind(this)
        });
      }

      this.getView().addEventDelegate({
        onAfterShow: function () {
          this._ensureMap();
        }.bind(this)
      });

      this._loadApprovedDrivers();
      this._loadDriverList();
      this._loadTruckList();
      this._loadPendingRegistrations();
      this._checkAuthStatus();
    },

    onAfterRendering: function () {
      this._ensureMap();
    },

    onLoginTabSelect: function (oEvent) {
      this._viewModel.setProperty("/loginTab", oEvent.getParameter("key"));
    },

    onAdminLoginPress: function () {
      try {
        window.sessionStorage.setItem("adminLoginIntent", "true");
      } catch (e) { /* private browsing may block sessionStorage */ }
      window.location.href = "/login";
    },

    onDriverLoginPress: async function () {
      const credentials = this._viewModel.getProperty("/driverLogin") || {};
      this._viewModel.setProperty("/authError", "");

      try {
        const response = await this._post("/drivers/login", {
          email: credentials.email,
          password: credentials.password
        });

        try {
          window.sessionStorage.setItem("driverLoginIntent", "true");
        } catch (e) { /* private browsing */ }

        this._viewModel.setProperty("/driverLogin/password", "");
        this._viewModel.setProperty("/driverCsrfToken", response.csrfToken || null);
        await this._checkAuthStatus();
        MessageToast.show("Logged in as driver");
      } catch (error) {
        this._clearDriverSessionData();
        this._viewModel.setProperty("/authError", "Invalid email or password.");
        MessageToast.show("Invalid email or password.");
      }
    },

    onLogoutPress: async function () {
      var role = this._viewModel.getProperty("/role");
      if (role === "driver") {
        try {
          await this._post("/drivers/logout", {});
        } catch (error) {
          // Ignore logout errors and reset the UI.
        }
        this._clearDriverSessionData();
        this._setView("loginPage", null);
        return;
      }

      // Clear the admin login intent so the next page load shows
      // the auth chooser instead of auto-detecting the XSUAA session.
      try {
        window.sessionStorage.removeItem("adminLoginIntent");
      } catch (e) { /* private browsing */ }
      window.location.href = "/do/logout";
    },

    onGoToLogin: function () {
      this._viewModel.setProperty("/authError", "");
      this._setView("loginPage", null);
    },

    onNavigateToFleetOverview: async function () {
      await this._loadApprovedDrivers();
      await this._loadTruckList();
      this.byId("app").to(this.byId("fleetOverviewPage"));
    },

    onNavigateBackToDashboard: function () {
      this.byId("app").back();
    },

    onNavigateToTruckDetail: async function (oEvent) {
      const truckId = oEvent.getSource().data("truckId");
      const model = this.getView().getModel("appState");
      const trucks = model.getProperty("/trucks") || [];
      const truck = trucks.find(function (item) {
        return item.ID === truckId;
      });

      model.setProperty("/selectedTruck", truck || {});
      model.setProperty("/selectedTruckId", truckId);
      model.setProperty("/truckMetrics", []);
      model.setProperty("/truckMetricsSummary", {});
      model.setProperty("/truckFreightHistory", []);
      await this._loadTruckThresholds(truckId);
      this.byId("app").to(this.byId("truckDetailPage"));
    },

    onNavigateBackToFleet: function () {
      this.byId("app").back();
    },

    onRefreshFleetOverview: async function () {
      await this._loadApprovedDrivers();
      await this._loadTruckList();
    },

    onNavigateToFreightOrders: async function () {
      await this._loadApprovedDrivers();
      await this._loadTruckList();
      await this._loadFreightOrders();
      this.byId("app").to(this.byId("freightOrdersPage"));
    },

    onNavigateToGatePasses: async function () {
      await this._loadApprovedDrivers();
      await this._loadTruckList();
      await this._loadFreightOrders();
      await this._loadGatePasses();
      this.byId("app").to(this.byId("gatePassesPage"));
    },

    onSelectTruck: function (oEvent) {
      const item = oEvent.getParameter("listItem");
      const context = item && item.getBindingContext("appState");
      if (!context) {
        return;
      }

      const truck = context.getObject();
      this._viewModel.setProperty("/selectedTruck", truck || {});
      this._viewModel.setProperty("/selectedTruckId", truck && truck.ID);
    },

    _loadFreightOrders: async function () {
      try {
        const model = this.getView().getModel("appState");
        const status = model.getProperty("/freightOrderStatusFilter");
        const url = status === "ALL"
          ? "/tracker/freight-orders"
          : "/tracker/freight-orders?status=" + encodeURIComponent(status);
        const response = await fetch(url, { credentials: "include" });
        if (!response.ok) {
          throw new Error(await this._extractError(response));
        }
        const data = await response.json();
        const rawOrders = data.value || data.orders || [];
        const trucks = model.getProperty("/trucks") || [];
        const drivers = model.getProperty("/approvedDrivers") || [];
        const truckMap = trucks.reduce(function (map, truck) {
          if (truck.ID) {
            map[truck.ID] = truck;
          }
          return map;
        }, {});
        const driverMap = drivers.reduce(function (map, driver) {
          if (driver.ID) {
            map[driver.ID] = driver;
          }
          return map;
        }, {});
        const orders = rawOrders.map(function (order) {
          const truckId = order.truck_ID || order.TRUCK_ID || order.truckId || (order.truck && (order.truck.ID || order.truck.id));
          const driverId = order.driver_ID || order.DRIVER_ID || order.driverId || (order.driver && (order.driver.ID || order.driver.id));
          const truck = truckMap[truckId] || {};
          const driver = driverMap[driverId] || {};
          return Object.assign({}, order, {
            ID: order.ID || order.Id || order.id,
            truck_ID: truckId || null,
            driver_ID: driverId || null,
            truckNumber: order.truckNumber || order.TRUCKNUMBER || truck.truckNumber || "-",
            driverName: order.driverName || order.DRIVERNAME || driver.name || "-",
            checkpointCount: order.checkpointCount != null ? order.checkpointCount : order.CHECKPOINTCOUNT || 0
          });
        });
        const counts = {
          total: orders.length,
          planned: orders.filter(function (order) { return order.status === "PLANNED"; }).length,
          dispatched: orders.filter(function (order) { return order.status === "DISPATCHED"; }).length,
          delivered: orders.filter(function (order) { return order.status === "DELIVERED"; }).length,
          cancelled: orders.filter(function (order) { return order.status === "CANCELLED"; }).length
        };

        model.setProperty("/freightOrders", orders);
        model.setProperty("/freightOrderCount", orders.length);
        model.setProperty("/freightOrderCounts", counts);
      } catch (error) {
        MessageToast.show("Failed to load freight orders: " + (error.message || "Unknown error"));
      }
    },

    _loadGatePasses: async function () {
      try {
        const model = this.getView().getModel("appState");
        const filter = model.getProperty("/gatePassFilter") || {};
        const params = new URLSearchParams();
        if (filter.truckId) {
          params.set("truckId", filter.truckId);
        }
        if (filter.freightOrderId) {
          params.set("freightOrderId", filter.freightOrderId);
        }

        const response = await fetch("/tracker/gate-passes" + (params.toString() ? "?" + params.toString() : ""), {
          credentials: "include"
        });
        if (!response.ok) {
          throw new Error(await this._extractError(response));
        }

        const data = await response.json();
        const rawPasses = data.value || data.passes || [];
        const trucks = model.getProperty("/trucks") || [];
        const drivers = model.getProperty("/approvedDrivers") || [];
        const orders = model.getProperty("/freightOrders") || [];
        const truckMap = trucks.reduce(function (map, truck) {
          if (truck.ID) {
            map[truck.ID] = truck;
          }
          return map;
        }, {});
        const driverMap = drivers.reduce(function (map, driver) {
          if (driver.ID) {
            map[driver.ID] = driver;
          }
          return map;
        }, {});
        const orderMap = orders.reduce(function (map, order) {
          if (order.ID) {
            map[order.ID] = order;
          }
          return map;
        }, {});

        const passes = rawPasses.map(function (pass) {
          const truckId = pass.truck_ID || pass.TRUCK_ID || pass.truckId || (pass.truck && (pass.truck.ID || pass.truck.id));
          const driverId = pass.driver_ID || pass.DRIVER_ID || pass.driverId || (pass.driver && (pass.driver.ID || pass.driver.id));
          const orderId = pass.freightOrder_ID || pass.FREIGHTORDER_ID || pass.freightOrderId || (pass.freightOrder && (pass.freightOrder.ID || pass.freightOrder.id));
          const truck = truckMap[truckId] || {};
          const driver = driverMap[driverId] || {};
          const order = orderMap[orderId] || {};
          return Object.assign({}, pass, {
            ID: pass.ID || pass.Id || pass.id,
            truck_ID: truckId || null,
            driver_ID: driverId || null,
            freightOrder_ID: orderId || null,
            orderNumber: pass.orderNumber || pass.ORDERNUMBER || order.orderNumber || "-",
            truckNumber: pass.truckNumber || pass.TRUCKNUMBER || truck.truckNumber || "-",
            driverName: pass.driverName || pass.DRIVERNAME || driver.name || "-"
          });
        });

        const counts = {
          total: passes.length,
          out: passes.filter(function (pass) { return pass.direction === "OUT"; }).length,
          in: passes.filter(function (pass) { return pass.direction === "IN"; }).length,
          pending: passes.filter(function (pass) { return pass.status === "PENDING"; }).length
        };

        model.setProperty("/gatePasses", passes);
        model.setProperty("/gatePassCount", passes.length);
        model.setProperty("/gatePassCounts", counts);
      } catch (error) {
        MessageToast.show("Failed to load gate passes: " + (error.message || "Unknown error"));
      }
    },

    onGatePassFilterChange: function () {
      const model = this.getView().getModel("appState");
      const truckFilter = this.byId("gatePassTruckFilter");
      const orderFilter = this.byId("gatePassOrderFilter");
      const truckKey = truckFilter ? truckFilter.getSelectedKey() : "";
      const orderKey = orderFilter ? orderFilter.getSelectedKey() : "";

      model.setProperty("/gatePassFilter/truckId", truckKey || null);
      model.setProperty("/gatePassFilter/freightOrderId", orderKey || null);
      this._loadGatePasses();
    },

    onClearGatePassFilters: function () {
      const model = this.getView().getModel("appState");
      const truckFilter = this.byId("gatePassTruckFilter");
      const orderFilter = this.byId("gatePassOrderFilter");

      model.setProperty("/gatePassFilter", { truckId: null, freightOrderId: null });
      if (truckFilter) {
        truckFilter.setSelectedKey("");
      }
      if (orderFilter) {
        orderFilter.setSelectedKey("");
      }
      this._loadGatePasses();
    },

    onRefreshGatePasses: function () {
      this._loadGatePasses();
    },

    onOpenGatePassDialog: async function () {
      const model = this.getView().getModel("appState");
      model.setProperty("/newGatePass", {
        freightOrder_ID: null,
        truck_ID: null,
        driver_ID: null,
        gateOfficer: "",
        direction: "OUT",
        remarks: "",
        truckDisplay: "",
        driverDisplay: ""
      });

      if (!(model.getProperty("/freightOrders") || []).length) {
        await this._loadFreightOrders();
      }

      if (!this._gatePassDialog) {
        this._gatePassDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.GatePassDialog",
          controller: this
        });
        this.getView().addDependent(this._gatePassDialog);
      }
      this._gatePassDialog.open();
    },

    onCancelGatePassDialog: function () {
      if (this._gatePassDialog) {
        this._gatePassDialog.close();
      }
    },

    onGatePassOrderChange: function (oEvent) {
      const selectedItem = oEvent.getParameter("selectedItem");
      const orderId = selectedItem && selectedItem.getKey();
      const model = this.getView().getModel("appState");
      const orders = model.getProperty("/freightOrders") || [];
      const order = orders.find(function (item) {
        return item.ID === orderId;
      });

      if (order) {
        model.setProperty("/newGatePass/freightOrder_ID", orderId);
        model.setProperty("/newGatePass/truck_ID", order.truck_ID || null);
        model.setProperty("/newGatePass/driver_ID", order.driver_ID || null);
        model.setProperty("/newGatePass/truckDisplay", order.truckNumber || "");
        model.setProperty("/newGatePass/driverDisplay", order.driverName || "");
      }
    },

    onCreateGatePass: async function () {
      const model = this.getView().getModel("appState");
      const gatePass = model.getProperty("/newGatePass") || {};

      if (!gatePass.freightOrder_ID) {
        MessageToast.show("Please select a freight order");
        return;
      }
      if (!String(gatePass.gateOfficer || "").trim()) {
        MessageToast.show("Gate officer name is required");
        return;
      }
      if (!gatePass.direction) {
        MessageToast.show("Please select a direction");
        return;
      }

      const existing = model.getProperty("/gatePasses") || [];
      const lastPass = existing
        .filter(function (pass) {
          return pass.truck_ID === gatePass.truck_ID;
        })
        .sort(function (a, b) {
          return new Date(b.passedAt || 0) - new Date(a.passedAt || 0);
        })[0];

      if (lastPass && lastPass.direction === gatePass.direction) {
        MessageBox.confirm(
          "The last recorded pass for this truck was also \"" + gatePass.direction + "\". Are you sure?",
          {
            title: "Duplicate Direction Warning",
            onClose: async function (action) {
              if (action === MessageBox.Action.OK) {
                await this._submitGatePass(gatePass);
              }
            }.bind(this)
          }
        );
        return;
      }

      await this._submitGatePass(gatePass);
    },

    _submitGatePass: async function (gatePass) {
      try {
        await this._fetchWithCsrf("/tracker/gate-passes", "POST", {
          freightOrder_ID: gatePass.freightOrder_ID,
          truck_ID: gatePass.truck_ID,
          driver_ID: gatePass.driver_ID,
          gateOfficer: gatePass.gateOfficer,
          direction: gatePass.direction,
          remarks: gatePass.remarks
        });
        MessageToast.show("Gate pass logged - Truck " + (gatePass.direction === "OUT" ? "departed" : "returned"));
        this._gatePassDialog.close();
        this._loadGatePasses();
      } catch (error) {
        MessageBox.error("Failed to log gate pass: " + (error.message || "Unknown error"));
      }
    },

    onFreightStatusFilterChange: function () {
      this._loadFreightOrders();
    },

    onRefreshFreightOrders: function () {
      this._loadFreightOrders();
    },

    onSelectFreightOrder: function (oEvent) {
      const item = oEvent.getParameter("listItem");
      const context = item && item.getBindingContext("appState");
      if (!context) {
        return;
      }
      const order = context.getObject();
      this._viewModel.setProperty("/selectedFreightOrder", order || {});
      this._viewModel.setProperty("/selectedFreightOrderId", order && order.ID);
    },

    onOpenFreightOrderDialog: async function () {
      this.getView().getModel("appState").setProperty("/newFreightOrder", {
        orderNumber: "",
        truck_ID: null,
        driver_ID: null,
        origin: "",
        destination: "",
        plannedDeparture: null,
        plannedArrival: null,
        checkpointCount: 0
      });
      this.getView().getModel("appState").setProperty("/selectedFreightOrderId", null);
      await this._loadApprovedDrivers();
      await this._loadTruckList();
      await this._ensureFreightOrderDialog();
      this._setFreightOrderDialogMode("create");
      this._freightOrderDialog.open();
    },

    onCancelFreightOrderDialog: function () {
      if (this._freightOrderDialog) {
        this._freightOrderDialog.close();
      }
      this._setFreightOrderDialogMode("create");
      this.getView().getModel("appState").setProperty("/selectedFreightOrderId", null);
    },

    onFreightOrderTruckChange: function (oEvent) {
      const selectedItem = oEvent.getParameter("selectedItem");
      const truckId = selectedItem && selectedItem.getKey();
      const model = this.getView().getModel("appState");
      model.setProperty("/newFreightOrder/truck_ID", truckId);

      const trucks = model.getProperty("/trucks") || [];
      const truck = trucks.find(function (item) {
        return item.ID === truckId;
      });
      if (truck && truck.assignedDriver_ID) {
        model.setProperty("/newFreightOrder/driver_ID", truck.assignedDriver_ID);
      }
    },

    onCreateFreightOrder: async function () {
      const model = this.getView().getModel("appState");
      const order = model.getProperty("/newFreightOrder") || {};

      if (!String(order.orderNumber || "").trim()) {
        MessageToast.show("Order number is required");
        return;
      }
      if (!order.truck_ID) {
        MessageToast.show("Please select a truck");
        return;
      }
      if (!order.driver_ID) {
        MessageToast.show("Please select a driver");
        return;
      }
      if (!String(order.origin || "").trim()) {
        MessageToast.show("Origin is required");
        return;
      }
      if (!String(order.destination || "").trim()) {
        MessageToast.show("Destination is required");
        return;
      }

      try {
        await this._fetchWithCsrf("/tracker/freight-orders", "POST", order);
        MessageToast.show("Freight order created successfully");
        this._freightOrderDialog.close();
        this._setFreightOrderDialogMode("create");
        this._loadFreightOrders();
      } catch (error) {
        MessageBox.error("Failed to create order: " + (error.message || "Unknown error"));
      }
    },

    onDispatchFreightOrder: function (oEvent) {
      const orderId = oEvent.getSource().data("orderId");
      const model = this.getView().getModel("appState");
      const orders = model.getProperty("/freightOrders") || [];
      const order = orders.find(function (item) {
        return item.ID === orderId;
      });

      MessageBox.confirm(
        "Dispatch order " + ((order && order.orderNumber) || "") + "?\n\nThis will create an active trip and the driver will be notified.",
        {
          title: "Confirm Dispatch",
          onClose: async function (action) {
            if (action !== MessageBox.Action.OK) {
              return;
            }
            try {
              const result = await this._fetchWithCsrf("/tracker/freight-orders/" + orderId + "/dispatch", "POST");
              MessageToast.show("Order dispatched. Trip \"" + ((result.trip && result.trip.title) || "created") + "\" is now active.");
              this._loadFreightOrders();
            } catch (error) {
              MessageBox.error("Dispatch failed: " + (error.message || "Unknown error"));
            }
          }.bind(this)
        }
      );
    },

    onEditFreightOrder: async function (oEvent) {
      const orderId = oEvent.getSource().data("orderId");
      const model = this.getView().getModel("appState");
      const orders = model.getProperty("/freightOrders") || [];
      const order = orders.find(function (item) {
        return item.ID === orderId;
      });
      if (!order) {
        return;
      }

      model.setProperty("/selectedFreightOrderId", orderId);
      model.setProperty("/newFreightOrder", {
        orderNumber: order.orderNumber || "",
        truck_ID: order.truck_ID || null,
        driver_ID: order.driver_ID || null,
        origin: order.origin || "",
        destination: order.destination || "",
        plannedDeparture: order.plannedDeparture || null,
        plannedArrival: order.plannedArrival || null,
        checkpointCount: order.checkpointCount || 0
      });

      await this._loadApprovedDrivers();
      await this._loadTruckList();
      await this._ensureFreightOrderDialog();
      this._setFreightOrderDialogMode("edit");
      this._freightOrderDialog.open();
    },

    onSaveFreightOrderEdit: async function () {
      const model = this.getView().getModel("appState");
      const orderId = model.getProperty("/selectedFreightOrderId");
      const updates = model.getProperty("/newFreightOrder");

      try {
        await this._fetchWithCsrf("/tracker/freight-orders/" + orderId, "PUT", updates);
        MessageToast.show("Order updated");
        this._freightOrderDialog.close();
        this._setFreightOrderDialogMode("create");
        model.setProperty("/selectedFreightOrderId", null);
        this._loadFreightOrders();
      } catch (error) {
        MessageBox.error("Update failed: " + (error.message || "Unknown error"));
      }
    },

    onViewCheckpoints: async function (oEvent) {
      const orderId = oEvent.getSource().data("orderId");
      const model = this.getView().getModel("appState");
      const orders = model.getProperty("/freightOrders") || [];
      const order = orders.find(function (item) {
        return item.ID === orderId;
      });
      model.setProperty("/selectedFreightOrder", order || {});
      model.setProperty("/selectedFreightOrderId", orderId);

      try {
        const response = await fetch("/tracker/freight-orders/" + orderId + "/checkpoints", { credentials: "include" });
        if (!response.ok) {
          throw new Error(await this._extractError(response));
        }
        const data = await response.json();
        const readings = data.readings || data.value || [];
        model.setProperty("/freightOrderCheckpoints", {
          readings: readings,
          submitted: readings.length,
          isComplete: readings.length >= ((order && order.checkpointCount) || 0)
        });
      } catch (error) {
        MessageBox.error("Failed to load checkpoints: " + (error.message || "Unknown error"));
        return;
      }

      if (!this._checkpointsDialog) {
        this._checkpointsDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.CheckpointsDialog",
          controller: this
        });
        this.getView().addDependent(this._checkpointsDialog);
      }
      this._checkpointsDialog.open();
    },

    onCloseCheckpointsDialog: function () {
      if (this._checkpointsDialog) {
        this._checkpointsDialog.close();
      }
    },

    _ensureFreightOrderDialog: async function () {
      if (!this._freightOrderDialog) {
        this._freightOrderDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.FreightOrderDialog",
          controller: this
        });
        this.getView().addDependent(this._freightOrderDialog);
      }
    },

    _setFreightOrderDialogMode: function (mode) {
      if (!this._freightOrderDialog) {
        return;
      }
      const dialog = this.byId("freightOrderDialog");
      const submitButton = this.byId("foSubmitBtn");
      if (!dialog || !submitButton) {
        return;
      }

      submitButton.detachPress(this.onCreateFreightOrder, this);
      submitButton.detachPress(this.onSaveFreightOrderEdit, this);
      if (mode === "edit") {
        dialog.setTitle("Edit Freight Order");
        submitButton.setText("Save Changes");
        submitButton.attachPress(this.onSaveFreightOrderEdit, this);
      } else {
        dialog.setTitle("New Freight Order");
        submitButton.setText("Create Order");
        submitButton.attachPress(this.onCreateFreightOrder, this);
      }
    },




    // --- Trucks management ---
    onOpenAddTruckDialog: async function () {
      if (!this._addTruckDialog) {
        this._addTruckDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.AddTruckDialog",
          controller: this
        });
        this.getView().addDependent(this._addTruckDialog);
      }

      this._viewModel.setProperty("/addTruck", {
        truckNumber: null,
        model: "",
        registrationNumber: "",
        fuelType: "DIESEL",
        status: "IDLE",
        assignedDriver_ID: null
      });

      await this._loadTruckList();
      this._addTruckDialog.open();
    },

    onCancelAddTruck: function () {
      if (this._addTruckDialog) {
        this._addTruckDialog.close();
      }
    },

    onCreateTruck: async function () {
      const payload = this._viewModel.getProperty("/addTruck") || {};
      if (!payload.truckNumber || !payload.model || !payload.registrationNumber) {
        MessageBox.error("Truck number, model and registration are required.");
        return;
      }

      try {
        // Ensure admin entity exists and fetch its ID if possible
        try {
          const admins = await this._adminGet("/tracker/Admins");
          const adminEntity = Array.isArray(admins.value) && admins.value.length ? admins.value[0] : null;
          if (adminEntity && adminEntity.ID) payload.admin_ID = adminEntity.ID;
        } catch (e) {
          // ignore — server-side handler may derive admin association
        }

        await this._adminPost("/tracker/trucks", payload);
        if (this._addTruckDialog) this._addTruckDialog.close();
        await this._loadTruckList();
        MessageToast.show("Truck created");
      } catch (error) {
        MessageBox.error(error.message || "Unable to create truck");
      }
    },

    onDeleteTruck: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var truckId = context && context.getProperty("ID");
      if (!truckId) return;

      MessageBox.confirm("Deactivate this truck?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) return;
          try {
            await this._adminPost("/tracker/trucks/" + truckId + "/status", { status: "DEACTIVATED" });
            await this._loadTruckList();
            MessageToast.show("Truck deactivated");
          } catch (error) {
            MessageBox.error(error.message || "Unable to deactivate truck");
          }
        }.bind(this)
      });
    },

    _loadApprovedDrivers: async function () {
      if (!this._isAdmin()) {
        return;
      }

      try {
        const response = await this._adminGet("/tracker/Drivers?$filter=registrationStatus eq 'APPROVED'&$select=ID,name,phone,vehicleId");
        const drivers = this._getODataCollection(response).map(function (driver) {
          return this._normalizeDriver(driver);
        }.bind(this));
        this._viewModel.setProperty("/approvedDrivers", drivers);
      } catch (error) {
        MessageToast.show("Failed to load drivers: " + (error.message || "Unknown error"));
      }
    },

    _loadTruckList: async function () {
      if (!this._isAdmin()) return;
      try {
        await this._loadApprovedDrivers();
        const response = await this._adminGet("/tracker/trucks");
        const raw = this._getODataCollection(response);
        const trucks = raw.map(function (t) {
          return this._normalizeTruck(t);
        }.bind(this));
        const drivers = this._viewModel.getProperty("/approvedDrivers") || [];
        const driverMap = drivers.reduce(function (map, driver) {
          if (driver.ID) {
            map[driver.ID] = driver.name;
          }
          return map;
        }, {});
        const enriched = trucks.map(function (truck) {
          return Object.assign({}, truck, {
            assignedDriverName: driverMap[truck.assignedDriver_ID] || "-"
          });
        });
        this._allTrucks = enriched;
        this._viewModel.setProperty("/trucks", enriched);
        this._viewModel.setProperty("/fleetSummary", {
          total: enriched.length,
          active: enriched.filter(function (truck) {
            return truck.status === "ACTIVE" || truck.status === "ON_TRIP";
          }).length,
          idle: enriched.filter(function (truck) {
            return truck.status === "IDLE";
          }).length,
          deactivated: enriched.filter(function (truck) {
            return truck.status === "DEACTIVATED";
          }).length
        });
      } catch (error) {
        MessageBox.error(error.message || "Unable to load trucks");
      }
    },

    onOpenAssignDriverDialog: async function (oEvent) {
      const truckId = oEvent.getSource().data("truckId") || this._viewModel.getProperty("/selectedTruckId");
      const model = this.getView().getModel("appState");
      const trucks = model.getProperty("/trucks") || [];
      const truck = trucks.find(function (item) {
        return item.ID === truckId;
      });

      model.setProperty("/selectedTruckId", truckId);
      if (truck) {
        model.setProperty("/selectedTruck", truck);
      }
      model.setProperty("/assignDriver/selectedDriverId", truck && truck.assignedDriver_ID ? truck.assignedDriver_ID : null);

      await this._loadApprovedDrivers();
      if (!this._assignDriverDialog) {
        this._assignDriverDialog = await Fragment.load({
          id: this.getView().getId(),
          name: "com.locationtracker.locationtracker.fragment.AssignDriverDialog",
          controller: this
        });
        this.getView().addDependent(this._assignDriverDialog);
      }
      this._assignDriverDialog.open();
    },

    onConfirmAssignDriver: async function () {
      const model = this.getView().getModel("appState");
      const truckId = model.getProperty("/selectedTruckId");
      const driverId = model.getProperty("/assignDriver/selectedDriverId");

      if (!driverId) {
        MessageToast.show("Please select a driver");
        return;
      }

      try {
        await this._adminPost("/tracker/trucks/" + truckId + "/assign", { driverId: driverId });
        MessageToast.show("Driver assigned successfully");
        this._assignDriverDialog.close();
        await this._loadTruckList();
        const trucks = model.getProperty("/trucks") || [];
        const updated = trucks.find(function (truck) {
          return truck.ID === truckId;
        });
        if (updated) {
          model.setProperty("/selectedTruck", updated);
        }
      } catch (error) {
        MessageBox.error("Assignment failed: " + (error.message || "Unknown error"));
      }
    },

    onCancelAssignDriver: function () {
      if (this._assignDriverDialog) {
        this._assignDriverDialog.close();
      }
    },

    onSaveTruckDetails: async function () {
      const model = this.getView().getModel("appState");
      const truck = model.getProperty("/selectedTruck") || {};
      const truckId = model.getProperty("/selectedTruckId");

      try {
        await this._sendAdminRequest("/tracker/trucks/" + truckId, "PUT", {
          truckNumber: truck.truckNumber,
          model: truck.model,
          registrationNumber: truck.registrationNumber,
          fuelType: truck.fuelType,
          status: truck.status
        });
        MessageToast.show("Truck details saved");
        await this._loadTruckList();
      } catch (error) {
        MessageBox.error("Save failed: " + (error.message || "Unknown error"));
      }
    },

    _loadTruckThresholds: async function (truckId) {
      if (!truckId) {
        return;
      }

      try {
        const response = await this._adminGet("/tracker/trucks/" + truckId + "/thresholds");
        const data = response || {};
        const mapped = {
          FUEL_LEVEL: { warningAt: 20, criticalAt: 10 },
          TYRE_PRESSURE: { warningAt: 30, criticalAt: 26 },
          ENGINE_TEMP: { warningAt: 90, criticalAt: 105 }
        };
        (data.thresholds || data.value || []).forEach(function (threshold) {
          if (mapped[threshold.metricType]) {
            mapped[threshold.metricType].warningAt = threshold.warningAt;
            mapped[threshold.metricType].criticalAt = threshold.criticalAt;
          }
        });
        this._viewModel.setProperty("/thresholds", mapped);
        this._viewModel.setProperty("/truckThresholds", data.thresholds || data.value || []);
      } catch (error) {
        MessageToast.show("Could not load thresholds: " + (error.message || "Unknown error"));
      }
    },

    onSaveThresholds: async function () {
      const model = this.getView().getModel("appState");
      const truckId = model.getProperty("/selectedTruckId");
      const thresholds = model.getProperty("/thresholds");

      try {
        await this._adminPost("/tracker/trucks/" + truckId + "/thresholds", thresholds);
        MessageToast.show("Thresholds saved successfully");
      } catch (error) {
        MessageBox.error("Failed to save thresholds: " + (error.message || "Unknown error"));
      }
    },

    onLoadTruckMetrics: async function () {
      const model = this.getView().getModel("appState");
      const truckId = model.getProperty("/selectedTruckId");
      const picker = this.byId("metricsDateRange");
      const from = picker && picker.getDateValue() ? picker.getDateValue().toISOString() : "";
      const to = picker && picker.getSecondDateValue() ? picker.getSecondDateValue().toISOString() : "";
      const params = new URLSearchParams({ limit: "100" });

      if (from) {
        params.set("from", from);
      }
      if (to) {
        params.set("to", to);
      }

      try {
        const data = await this._adminGet("/tracker/trucks/" + truckId + "/metrics?" + params.toString());
        model.setProperty("/truckMetrics", data.readings || data.value || []);
        model.setProperty("/truckMetricsSummary", data.summary || {});
      } catch (error) {
        MessageBox.error("Failed to load metrics: " + (error.message || "Unknown error"));
      }
    },

    onDeactivateTruck: function (oEvent) {
      const truckId = oEvent.getSource().data("truckId");
      MessageBox.confirm("Deactivate this truck?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          try {
            await this._adminPost("/tracker/trucks/" + truckId + "/status", { status: "DEACTIVATED" });
            MessageToast.show("Truck deactivated");
            await this._loadTruckList();
          } catch (error) {
            MessageBox.error("Deactivation failed: " + (error.message || "Unknown error"));
          }
        }.bind(this)
      });
    },

    onTruckDetailTabSelect: async function (oEvent) {
      const key = oEvent.getParameter("selectedKey");
      if (key !== "freightHistory") {
        return;
      }

      const truckId = this.getView().getModel("appState").getProperty("/selectedTruckId");
      try {
        const data = await this._adminGet("/tracker/freight-orders?truckId=" + encodeURIComponent(truckId));
        this.getView().getModel("appState").setProperty("/truckFreightHistory", data.value || data.orders || []);
      } catch (error) {
        MessageToast.show("Failed to load freight history");
      }
    },


    onDeleteDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      if (!driverId) {
        return;
      }

      MessageBox.confirm("Deactivate this driver?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          try {
            await this._adminPost("/tracker/deleteDriver", { driverId });
            await this._loadDriverList();
            MessageToast.show("Driver deactivated");
          } catch (error) {
            MessageBox.error(error.message || "Unable to deactivate driver");
          }
        }.bind(this)
      });
    },

    onReactivateDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      if (!driverId) {
        return;
      }

      MessageBox.confirm("Reactivate this driver?", {
        onClose: async function (action) {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          try {
            await this._adminPost("/tracker/reactivateDriver", { driverId: driverId });
            await this._loadDriverList();
            MessageToast.show("Driver reactivated");
          } catch (error) {
            MessageBox.error(error.message || "Unable to reactivate driver");
          }
        }.bind(this)
      });
    },

    onPermanentlyDeleteDriver: function (oEvent) {
      var context = oEvent.getSource().getBindingContext("appState");
      var driverId = context && context.getProperty("ID");
      var driverName = context && context.getProperty("name");
      if (!driverId) {
        return;
      }

      MessageBox.warning(
        "Permanently delete driver '" + (driverName || "Unknown") + "'?\n\nThis will remove all associated trips and location data. This action cannot be undone.",
        {
          actions: ["Delete", MessageBox.Action.CANCEL],
          emphasizedAction: MessageBox.Action.CANCEL,
          onClose: async function (action) {
            if (action !== "Delete") {
              return;
            }
            try {
              await this._adminPost("/tracker/permanentlyDeleteDriver", { driverId: driverId });
              await this._loadDriverList();
              MessageToast.show("Driver permanently deleted");
            } catch (error) {
              MessageBox.error(error.message || "Unable to delete driver");
            }
          }.bind(this)
        }
      );
    },

    onStartTracking: async function () {
      if (!this._isDriver()) {
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
      if (!this._isDriver()) {
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

      this._viewModel.setProperty("/tracking", false);
      this._viewModel.setProperty("/statusText", "Tracking stopped");

      try {
        const stoppedTrip = await this._post("/drivers/stopTrip", { tripId: trip.ID });
        this._viewModel.setProperty("/currentTrip", stoppedTrip);
        await this._refreshMetrics();
        MessageToast.show("Trip stopped");
      } catch (error) {
        MessageBox.error(error.message || "Unable to stop tracking.");
      }
    },

    onRefreshPath: async function () {
      var isDriverView = this._isDriver();
      var isAdminView = this._isAdmin();
      if (!isDriverView && !isAdminView) {
        return;
      }

      var trip = this._viewModel.getProperty("/currentTrip");
      this._ensureMap();

      if (!trip || !trip.ID) {
        if (this._map) {
          this._map.invalidateSize();
        }
        return;
      }

      try {
        var pathUrl;
        if (isDriverView) {
          pathUrl = "/drivers/path/" + trip.ID;
        } else {
          pathUrl = "/tracker/path/" + trip.ID;
        }
        var pointsFetcher = isDriverView ? this._get(pathUrl) : this._adminGet(pathUrl);
        var points = await pointsFetcher;
        this._points = (points.value || []).map(function (point) {
          return [Number(point.latitude), Number(point.longitude)];
        });

        var lastPoint = points.value && points.value.length ? points.value[points.value.length - 1] : null;
        this._viewModel.setProperty("/lastPoint", lastPoint);
        this._viewModel.setProperty("/totalPoints", this._points.length);
        this._syncPolyline();
        if (isDriverView) {
          await this._refreshMetrics();
        }
      } catch (error) {
        MessageBox.error(error.message || "Unable to refresh the path.");
      }
    },

    onSelectDriver: async function (oEvent) {
      var oItem = oEvent.getParameter("listItem");
      var oContext = oItem && oItem.getBindingContext("appState");
      if (!oContext) {
        return;
      }

      var driverId = oContext.getProperty("ID");
      var driverName = oContext.getProperty("name");
      if (!driverId) {
        return;
      }

      this._viewModel.setProperty("/selectedDriverId", driverId);
      this._viewModel.setProperty("/selectedDriverName", driverName);

      // Reset current trip / points
      this._viewModel.setProperty("/currentTrip", null);
      this._viewModel.setProperty("/lastPoint", null);
      this._viewModel.setProperty("/totalPoints", 0);
      this._points = [];
      this._syncPolyline();

      try {
        // Fetch the selected driver's active trip
        var trip = await this._adminGet("/tracker/activeTrip/" + driverId);
        if (trip && trip.ID) {
          this._viewModel.setProperty("/currentTrip", trip);
          await this.onRefreshPath();
        } else {
          this._viewModel.setProperty("/currentTrip", { title: driverName + " - No active trip", status: "IDLE" });
        }

        // Fetch the selected driver's metrics
        await this._refreshAdminMetrics(driverId);
        MessageToast.show("Loaded data for " + driverName);
      } catch (error) {
        MessageBox.error(error.message || "Unable to load driver data.");
      }
    },

    onDriverSearch: function (oEvent) {
      var query = (oEvent.getParameter("newValue") || "").toLowerCase().trim();
      var source = this._allDrivers || this._viewModel.getProperty("/drivers") || [];
      var filtered = !query ? source : source.filter(function (d) {
        return (d.name || "").toLowerCase().indexOf(query) !== -1 ||
               (d.email || "").toLowerCase().indexOf(query) !== -1 ||
               (d.licenseNumber || "").toLowerCase().indexOf(query) !== -1;
      });
      this._viewModel.setProperty("/drivers", filtered);
    },

    onTruckSearch: function (oEvent) {
      var query = (oEvent.getParameter("newValue") || "").toLowerCase().trim();
      var source = this._allTrucks || this._viewModel.getProperty("/trucks") || [];
      var filtered = !query ? source : source.filter(function (t) {
        return (t.truckNumber || "").toLowerCase().indexOf(query) !== -1 ||
               (t.model || "").toLowerCase().indexOf(query) !== -1 ||
               (t.registrationNumber || "").toLowerCase().indexOf(query) !== -1;
      });
      this._viewModel.setProperty("/trucks", filtered);
    },

    _checkAuthStatus: async function () {
      this._setView("loading", null);
      this._viewModel.setProperty("/authError", "");

      const devRole = this._readDevRole();
      if (devRole === "driver") {
        this._viewModel.setProperty("/driverProfile", {
          name: "Developer Driver",
          email: "dev-driver@example.com"
        });
        this._setView("driverDashboard", "driver");
        return;
      }
      if (devRole === "admin") {
        this._viewModel.setProperty("/adminProfile", {
          name: "Developer Admin",
          email: "dev-admin@example.com"
        });
        this._setView("adminDashboard", "admin");
        await this._loadApprovedDrivers();
        await this._loadDriverList();
        await this._loadTruckList();
        await this._loadPendingRegistrations();
        return;
      }

      var driverLoginIntent = false;
      try {
        driverLoginIntent = window.sessionStorage.getItem("driverLoginIntent") === "true";
      } catch (e) { /* private browsing */ }

      if (driverLoginIntent) {
        try {
          const driverResponse = await this._get("/drivers/me");
          if (driverResponse && driverResponse.driver) {
            this._viewModel.setProperty("/driverProfile", driverResponse.driver || null);
            this._viewModel.setProperty("/driverCsrfToken", driverResponse.csrfToken || null);
            this._setView("driverDashboard", "driver");
            await this._loadActiveTrip();
            await this._refreshMetrics();
            return;
          }
        } catch (error) {
          // Driver session not active.
        }
        
        try {
          window.sessionStorage.removeItem("driverLoginIntent");
        } catch (e) { /* private browsing */ }
      }

      // Only probe the XSUAA-protected admin endpoint when the user
      // explicitly clicked "Login as Fleet Admin".  Without this gate
      // the app would auto-detect an existing XSUAA session and skip
      // the auth chooser page entirely.
      var adminLoginIntent = false;
      try {
        adminLoginIntent = window.sessionStorage.getItem("adminLoginIntent") === "true";
      } catch (e) { /* private browsing */ }

      if (adminLoginIntent) {
        try {
          var adminProfile = await this._getAdminProfile();
          if (adminProfile && adminProfile.isFleetAdmin) {
            this._viewModel.setProperty("/adminProfile", adminProfile);
            this._setView("adminDashboard", "admin");
            await this._loadApprovedDrivers();
            await this._loadDriverList();
            await this._loadTruckList();
            await this._loadPendingRegistrations();
            return;
          }
          if (adminProfile) {
            // Authenticated via XSUAA but does not have the FleetAdmin role.
            this._setView("error401", null);
            return;
          }
        } catch (error) {
          // XSUAA auth failed — fall through to login page.
        }
        // Admin login was intended but auth failed — clear the intent.
        try {
          window.sessionStorage.removeItem("adminLoginIntent");
        } catch (e) { /* private browsing */ }
      }

      this._setView("loginPage", null);
    },

    _loadDriverList: async function () {
      if (!this._isAdmin()) {
        return;
      }

      try {
        const response = await this._adminGet("/tracker/Drivers?$select=ID,name,email,vehicleId,phone,isActive,activityStatus,registrationStatus,licenseNumber,createdAt,documentUrl");
        const rawDrivers = this._getODataCollection(response);
        const drivers = rawDrivers.map(function (driver) {
          return this._normalizeDriver(driver);
        }.bind(this));
        this._allDrivers = drivers;
        this._viewModel.setProperty("/drivers", drivers);
        this._viewModel.setProperty("/driverSummary", {
          total: drivers.length,
          active: drivers.filter(function (d) { return d.isActive; }).length,
          onTrip: drivers.filter(function (d) { return d.activityStatus === "On Trip"; }).length,
          inactive: drivers.filter(function (d) { return !d.isActive; }).length
        });
      } catch (error) {
        MessageBox.error(error.message || "Unable to load drivers");
      }
    },

        _loadPendingRegistrations: async function () {
          try {
            const resp = await fetch('/tracker/pending-registrations', {
              credentials: 'include',
              headers: { 'Authorization': 'Bearer ' + (this._xsuaaToken || '') }
            });
            if (!resp.ok) throw new Error(await resp.text());
            const data = await resp.json();
            const model = this.getView().getModel('appState');
            model.setProperty('/pendingDrivers', data.value || []);
            model.setProperty('/pendingDriverCount', (data.value || []).length);
          } catch (err) {
            sap.m.MessageToast.show('Failed to load pending registrations: ' + err.message);
          }
        },

        onApproveDriver: async function (oEvent) {
          const driverId = oEvent.getSource().data('driverId');
          try {
            await this._ensureCsrfToken();
            const resp = await fetch(`/tracker/drivers/${driverId}/approve`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'X-CSRF-Token': this._csrfToken,
                'Content-Type': 'application/json'
              }
            });
            if (!resp.ok) {
              const err = await resp.json();
              throw new Error(err.error || resp.statusText);
            }
            sap.m.MessageToast.show('Driver approved successfully');
            this._loadPendingRegistrations();
            this._loadDriverList();
          } catch (err) {
            sap.m.MessageBox.error('Approval failed: ' + err.message);
          }
        },

        onOpenRejectDialog: async function (oEvent) {
          const driverId = oEvent.getSource().data('driverId');
          const model = this.getView().getModel('appState');
          model.setProperty('/selectedPendingDriverId', driverId);
          model.setProperty('/rejectReason', '');

          if (!this._rejectDriverDialog) {
            this._rejectDriverDialog = await Fragment.load({
              name: 'com.locationtracker.locationtracker.fragment.RejectDriverDialog',
              controller: this
            });
            this.getView().addDependent(this._rejectDriverDialog);
          }
          this._rejectDriverDialog.open();
        },

        onConfirmRejectDriver: async function () {
          const model   = this.getView().getModel('appState');
          const driverId = model.getProperty('/selectedPendingDriverId');
          const reason   = model.getProperty('/rejectReason');

          try {
            await this._ensureCsrfToken();
            const resp = await fetch(`/tracker/drivers/${driverId}/reject`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'X-CSRF-Token': this._csrfToken,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ reason })
            });
            if (!resp.ok) {
              const err = await resp.json();
              throw new Error(err.error || resp.statusText);
            }
            sap.m.MessageToast.show('Driver rejected');
            this._rejectDriverDialog.close();
            this._loadPendingRegistrations();
          } catch (err) {
            sap.m.MessageBox.error('Rejection failed: ' + err.message);
          }
        },

        onCancelRejectDriver: function () {
          if (this._rejectDriverDialog) {
            this._rejectDriverDialog.close();
          }
        },

        onViewDriverDoc: function (oEvent) {
          const docUrl = oEvent.getSource().data('driverDocUrl');
          if (docUrl) {
            window.open(docUrl, '_blank', 'noopener,noreferrer');
          }
        },

        _ensureCsrfToken: async function () {
          if (this._csrfToken) return;
          const resp = await fetch('/tracker/$metadata', {
            credentials: 'include',
            headers: { 'X-CSRF-Token': 'Fetch' }
          });
          this._csrfToken = resp.headers.get('X-CSRF-Token');
        },

        _getODataCollection: function (response) {
      if (response && Array.isArray(response.value)) {
        return response.value;
      }
      if (response && response.d) {
        if (Array.isArray(response.d.results)) {
          return response.d.results;
        }
        if (Array.isArray(response.d)) {
          return response.d;
        }
      }
      return [];
    },

    _normalizeDriver: function (driver) {
      const safeDriver = driver || {};
      const activeValue = safeDriver.isActive != null ? safeDriver.isActive : safeDriver.ISACTIVE;
      let isActive = null;
      if (activeValue != null) {
        if (typeof activeValue === "boolean") {
          isActive = activeValue;
        } else if (typeof activeValue === "number") {
          isActive = activeValue === 1;
        } else if (typeof activeValue === "string") {
          const normalized = activeValue.trim().toLowerCase();
          isActive = normalized === "true" || normalized === "1";
        } else {
          isActive = Boolean(activeValue);
        }
      }

      const activityStatus = safeDriver.activityStatus || "Idle";

      return {
        ID: safeDriver.ID || safeDriver.Id || safeDriver.id || null,
        name: safeDriver.name || safeDriver.NAME || "",
        email: safeDriver.email || safeDriver.EMAIL || "",
        vehicleId: safeDriver.vehicleId || safeDriver.VEHICLEID || null,
        phone: safeDriver.phone || safeDriver.PHONE || null,
        isActive,
        activityStatus,
        registrationStatus: safeDriver.registrationStatus || safeDriver.REGISTRATIONSTATUS || null,
        licenseNumber: safeDriver.licenseNumber || safeDriver.LICENSENUMBER || null,
        licenseExpiry: safeDriver.licenseExpiry || safeDriver.LICENSEEXPIRY || null,
        documentUrl: safeDriver.documentUrl || safeDriver.DOCUMENTURL || null,
        createdAt: safeDriver.createdAt || safeDriver.CREATEDAT || null,
        createdBy: safeDriver.createdBy || safeDriver.CREATEDBY || null,
        modifiedAt: safeDriver.modifiedAt || safeDriver.MODIFIEDAT || null,
        modifiedBy: safeDriver.modifiedBy || safeDriver.MODIFIEDBY || null
      };
    },

    formatDate: function (sDate) {
      try {
        if (!sDate) return "";
        var d = new Date(sDate);
        return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
      } catch (e) { return ""; }
    },

    formatDateTime: function (sDate) {
      if (!sDate) return "-";
      try {
        var d = new Date(sDate);
        return isNaN(d.getTime()) ? String(sDate) : d.toLocaleString(undefined, {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
      } catch (e) { return String(sDate); }
    },

    formatInitials: function (name) {
      if (!name) { return "?"; }
      var parts = name.trim().split(/\s+/);
      if (parts.length >= 2) {
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      }
      return name.substring(0, 2).toUpperCase();
    },

    _normalizeTruck: function (truck) {
      const t = truck || {};
      return {
        ID: t.ID || t.Id || t.id || null,
        truckNumber: t.truckNumber || t.TRUCKNUMBER || t.vehicle_number || null,
        model: t.model || t.MODEL || "",
        registrationNumber: t.registrationNumber || t.REGISTRATION_NUMBER || t.registration_number || "",
        fuelType: t.fuelType || t.FUEL_TYPE || "",
        status: t.status || t.STATUS || "",
        assignedDriver_ID: t.assignedDriver_ID || t.ASSIGNEDDRIVER_ID || (t.assignedDriver && (t.assignedDriver.ID || t.assignedDriver.id)) || null,
        assignedDriverName: t.assignedDriverName || t.assignedDriver_NAME || (t.assignedDriver && t.assignedDriver.name) || "-"
      };
    },


    _loadActiveTrip: async function () {
      if (!this._isDriver()) {
        return;
      }

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
        if (!this._isDriver()) {
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
        this._viewModel.setProperty("/statusText", error.message || "Unable to persist the current position");
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
      const mapHost = this.byId("trackerMap");
      const mapContainer = mapHost && mapHost.getDomRef();

      if (!mapContainer) {
        return;
      }

      if (!window.L) {
        const component = this.getOwnerComponent();
        if (component && component.getLeafletReady) {
          if (!this._leafletLoadPending) {
            this._leafletLoadPending = true;
            component.getLeafletReady()
              .then(function () {
                this._leafletLoadPending = false;
                this._ensureMap();
              }.bind(this))
              .catch(function () {
                this._leafletLoadPending = false;
                this._viewModel.setProperty("/statusText", "Leaflet failed to load");
              }.bind(this));
          }

          this._viewModel.setProperty("/statusText", "Loading map resources");
          return;
        }

        this._viewModel.setProperty("/statusText", "Leaflet failed to load");
        return;
      }

      const existingContainer = this._map && this._map.getContainer ? this._map.getContainer() : null;
      if (existingContainer && existingContainer !== mapContainer) {
        this._map.remove();
        this._map = null;
        this._polyline = null;
        this._marker = null;
      }

      if (this._map) {
        if (this._map.getContainer && this._map.getContainer() !== mapContainer) {
          this._map.remove();
          this._map = null;
          this._polyline = null;
          this._marker = null;
        } else {
          setTimeout(function () {
            this._map.invalidateSize();
          }.bind(this), 150);
          return;
        }
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

      if (this._points.length === 0) {
        if (this._marker) {
          this._map.removeLayer(this._marker);
          this._marker = null;
        }
        return;
      }

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
        const last = this._points[this._points.length - 1];
        if (!this._marker) {
          this._marker = window.L.marker(last).addTo(this._map);
        } else {
          this._marker.setLatLng(last);
        }
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
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _post: async function (url, payload) {
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
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
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _adminGet: async function (url) {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _adminPost: async function (url, payload) {
      const csrfToken = await this._getAdminCsrfToken();
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }

      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      return response.json();
    },

    _sendAdminRequest: async function (url, method, payload) {
      const csrfToken = await this._getAdminCsrfToken();
      const headers = {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (csrfToken) {
        headers["X-CSRF-Token"] = csrfToken;
      }
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method: method,
        headers: headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      if (response.status === 204) {
        return null;
      }
      return response.json();
    },

    _fetchWithCsrf: async function (url, method, payload) {
      await this._ensureCsrfToken();
      const headers = {
        "X-CSRF-Token": this._csrfToken || "",
        "X-Requested-With": "XMLHttpRequest"
      };
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
      }

      const response = await fetch(url, {
        method: method,
        credentials: "include",
        headers: headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      if (response.status === 204) {
        return {};
      }
      return response.json();
    },


    _getAdminCsrfToken: async function () {
      if (this._adminCsrfToken) {
        return this._adminCsrfToken;
      }

      const response = await fetch("/tracker/$metadata", {
        headers: {
          "X-CSRF-Token": "Fetch",
          "X-Requested-With": "XMLHttpRequest"
        }
      });

      if (!response.ok) {
        const error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      this._adminCsrfToken = response.headers.get("X-CSRF-Token");
      return this._adminCsrfToken;
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
        if (!this._isDriver()) {
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

    _clearDriverSessionData: function () {
      if (this._watchId !== null) {
        navigator.geolocation.clearWatch(this._watchId);
        this._watchId = null;
      }

      this._viewModel.setProperty("/role", null);
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
    },

    _setView: function (viewName, role) {
      this._viewModel.setProperty("/sCurrentView", viewName);
      this._viewModel.setProperty("/role", role);
    },

    _readDevRole: function () {
      try {
        const role = window.localStorage.getItem(DEV_ROLE_KEY);
        return role === "admin" || role === "driver" ? role : null;
      } catch (error) {
        return null;
      }
    },

    _isDriver: function () {
      return this._viewModel.getProperty("/role") === "driver";
    },

    _isAdmin: function () {
      return this._viewModel.getProperty("/role") === "admin";
    },

    _getAdminProfile: async function () {
      // Use redirect:"manual" so the approuter's XSUAA 302-redirect to
      // accounts.sap.com is NOT followed by the browser.  Instead we see
      // a "type: opaqueredirect" response and can treat it as "not logged in".
      var response = await fetch("/tracker/me()", {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        },
        redirect: "manual"
      });

      // An opaque redirect (type === "opaqueredirect") means the approuter
      // tried to send us to the IDP login page — treat as unauthenticated.
      if (response.type === "opaqueredirect" || response.status === 0) {
        return null;
      }

      if (!response.ok) {
        var error = new Error(await this._extractError(response));
        error.status = response.status;
        throw error;
      }

      var data = await response.json();

      return {
        name: data && data.name ? data.name : "Fleet Admin",
        email: data && data.email ? data.email : "",
        isFleetAdmin: Boolean(data && data.isAdmin)
      };
    },

    _refreshAdminMetrics: async function (driverId) {
      if (!driverId) {
        return;
      }

      try {
        var metrics = await this._adminGet("/tracker/driverMetrics/" + driverId);
        this._viewModel.setProperty("/metrics", Object.assign({}, metrics, {
          avgClientUpdateLatencyMs: 0,
          latestClientUpdateLatencyMs: 0
        }));
      } catch (error) {
        this._viewModel.setProperty("/statusText", "Admin metrics unavailable");
      }
    }
  });
});
