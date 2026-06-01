# Location Tracker - Fleet & Driver Management System

A comprehensive, enterprise-ready SAP Cloud Application Programming Model (CAP) solution designed for real-time fleet tracking, driver management, and geolocation analytics. 

This application offers a dual-dashboard architecture serving two distinct user personas: **Fleet Administrators** and **Drivers**, utilizing a hybrid authentication model combining SAP XSUAA and custom JWT-based authentication.

## 🚀 Key Features

### Fleet Administrator Dashboard
- **Secure Access**: Protected by SAP XSUAA authentication requiring the `FleetAdmin` role.
- **Driver Management**: Complete CRUD capabilities for managing fleet drivers (Create, Deactivate, Reactivate, Permanently Delete).
- **System Overview**: High-level visibility into the fleet workforce.

### Driver Dashboard
- **Frictionless Authentication**: Custom email and password login utilizing secure HTTP-only JWT cookies.
- **Live Trip Tracking**: Initiate trips and continuously stream high-accuracy GPS coordinates (`latitude`, `longitude`, `accuracy`, `speed`) directly from the browser to the SAP HANA database.
- **Interactive Route Mapping**: Visualizes the live trip path in real-time using Leaflet.js and OpenStreetMap.
- **Performance Analytics**: Live performance metrics evaluating GPS accuracy, trip completion rates, and backend database ingestion latencies (tracking clock drift and sync speeds).

## 🏗️ Architecture & Technology Stack

- **Backend Framework**: SAP Cloud Application Programming Model (CAP) Node.js
- **Database**: SAP HANA Cloud (Production) / SQLite (Local Development)
- **Frontend UI**: SAPUI5 (Freestyle Application)
- **Mapping Engine**: Leaflet.js
- **Authentication**:
  - `XSUAA` for enterprise Admin SSO.
  - `bcryptjs` + `jsonwebtoken` custom Express endpoints for Driver access.
- **Deployment**: SAP BTP Cloud Foundry (via `mta.yaml`)

## 📂 Project Structure

```text
Location_Tracker/
├── app/
│   ├── locationtracker/       # SAPUI5 Frontend Application
│   │   ├── webapp/            
│   │   │   ├── controller/    # UI logic (App.controller.js)
│   │   │   ├── view/          # XML Views for Admin and Driver Dashboards
│   │   │   ├── fragment/      # Reusable UI fragments (e.g., Add Driver Dialog)
│   │   │   └── css/           # Custom styling
│   └── router/                # Approuter configuration for SAP BTP deployment
├── db/
│   └── schema.cds             # Core Data Services (CDS) entity models (Trips, Drivers, Points)
├── srv/
│   ├── tracker_service.cds    # OData service definition with XSUAA role restrictions
│   └── tracker_service.js     # Custom handlers for OData (Admin driver management)
├── server.js                  # Express.js server extension handling custom Driver Auth & Map REST APIs
├── mta.yaml                   # Multi-Target Application deployment descriptor
└── package.json               # Node.js dependencies and run scripts
```

## 🔒 Authentication Flow Deep Dive

The application employs a sophisticated routing mechanism to handle dual-identities seamlessly:
1. **The Auth Chooser**: On a fresh session, users land on an Auth Chooser page to select their role. 
2. **Admin Flow**: Redirects to SAP XSUAA. Upon successful login, the Approuter forwards the JWT token to the backend, unlocking the `@requires: 'FleetAdmin'` OData endpoints.
3. **Driver Flow**: A custom Express route (`/drivers/login`) authenticates the driver's hashed password stored in HANA and issues an HTTP-Only JWT Cookie (`driver-jwt`).
4. **Session Intent Gating**: Frontend `sessionStorage` tracks `adminLoginIntent` and `driverLoginIntent` to prevent unwanted auto-logins across fresh browser tabs, preserving a smooth user experience upon hard refreshes without sacrificing security.

## 🛠️ Local Development Setup

1. **Install Dependencies:**
   ```bash
   npm install
   ```

2. **Run Locally (with SQLite in-memory DB):**
   ```bash
   npm run start
   ```
   *This uses the local SQLite database defined in CAP, ideal for rapid prototyping without HANA overhead.*

3. **Watch Mode (Frontend Auto-reload):**
   ```bash
   npm run watch-locationtracker
   ```

## ☁️ Deployment to SAP BTP Cloud Foundry

This project is fully configured for SAP BTP via the `mta.yaml` descriptor.

1. **Build the MTA Archive:**
   ```bash
   mbt build
   ```
2. **Deploy to Cloud Foundry:**
   ```bash
   cf deploy mta_archives/locationtracker_1.0.0.mtar
   ```

## 📊 Database Schema Highlights

The application relies on a normalized CDS data model (`db/schema.cds`):
- `Admins`: Tracks fleet managers.
- `Drivers`: Stores driver details and securely hashed passwords.
- `Trips`: Links drivers to their active/completed trips.
- `LocationPoints`: High-frequency geolocation pings linked to trips, strictly tracking insertion latencies via standard CAP `managed` annotations (`createdAt`).

## 🤝 Contribution Guidelines
When making modifications, please ensure that:
- Any new custom REST endpoints for drivers are added to `server.js` and wrapped with the `requireDriverAuth` middleware.
- Admin management endpoints remain in `srv/tracker_service.cds` to leverage native XSUAA protections.
- Database queries across raw endpoints utilize case-insensitive column mappings (e.g., `trip.ID || trip.id || trip.ID`) to maintain compatibility between local SQLite and production SAP HANA environments.
