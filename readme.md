# Location Tracker — Fleet & Driver Management Platform

A comprehensive, enterprise-ready **SAP Cloud Application Programming Model (CAP)** platform for real-time fleet tracking, driver management, and geolocation analytics — spanning a full-stack web application and a native Android companion app.

The platform serves two distinct user personas through a tri-surface architecture:

| Surface | Persona | Technology |
|---------|---------|------------|
| **Fleet Admin Dashboard** | Fleet Managers | SAPUI5 Web Application |
| **Driver Dashboard** | Drivers (Browser) | SAPUI5 Web Application |
| **Fleet Driver App** | Drivers (Mobile) | Capacitor + Vite Android App |

All three surfaces share a **single CAP Node.js backend** deployed on SAP BTP Cloud Foundry, backed by SAP HANA Cloud.

---

## 📹 Live Demo & Walkthrough
*(Embed or link your demonstration video here. Example: `[![Watch the video](https://img.youtube.com/vi/YOUR_VIDEO_ID/hqdefault.jpg)](https://youtu.be/YOUR_VIDEO_ID)`)*

Since this application uses enterprise-grade SAP XSUAA for its Admin dashboard, public access is securely restricted. Please watch the video above to see the full tri-surface flow (Admin Dashboard, Driver Web, & Driver Mobile App) in action!

## 📸 Screenshots

### Web Application

<p align="center">
  <img src="docs/screenshots/Screenshot 1.png" alt="Auth Chooser — Role selection screen with Admin and Driver login options" width="700" />
</p>
<p align="center"><em>Auth Chooser — Select between Fleet Admin (XSUAA SSO) and Driver (email/password) login</em></p>

<p align="center">
  <img src="docs/screenshots/Screenshot 2.png" alt="Fleet Admin Dashboard — Driver management table with live trip and position data" width="700" />
</p>
<p align="center"><em>Fleet Admin Dashboard — Driver list with status, live trip details, and captured GPS points</em></p>

<p align="center">
  <img src="docs/screenshots/Screenshot 3.png" alt="Admin Driver Metrics — Route map and performance analytics for a selected driver" width="700" />
</p>
<p align="center"><em>Admin Driver Metrics — Real-time route map, trip completion rate, GPS accuracy, and ingest latency</em></p>

<p align="center">
  <img src="docs/screenshots/Screenshot 4.png" alt="Driver Dashboard — Live trip tracking with route map and KPI cards" width="700" />
</p>
<p align="center"><em>Driver Dashboard — Active trip tracking with live coordinates, route map, and path density</em></p>

### Mobile App (Android — Capacitor)

<p align="center">
  <img src="docs/screenshots/Screenshot 5.jpeg" alt="Fleet Driver App — Login screen on Android" width="300" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/screenshots/Screenshot 6.jpeg" alt="Fleet Driver App — Active trip with GPS streaming" width="300" />
</p>
<p align="center"><em>Fleet Driver App — Login screen (left) and active trip with live GPS streaming (right)</em></p>

---

## 🚀 Key Features

### Fleet Administrator Dashboard (Web)
- **Secure Access**: Protected by SAP XSUAA authentication requiring the `FleetAdmin` role.
- **Driver Management**: Complete CRUD capabilities for managing fleet drivers (Create, Deactivate, Reactivate, Permanently Delete).
- **Live Monitoring**: Select any driver to view their active trip, live position, route map, and captured GPS points in real time.
- **Per-Driver Performance Metrics**: View aggregated analytics per driver — trip counts, completion rates, GPS accuracy, session duration, and backend ingest latency.
- **System Overview**: High-level visibility into the entire fleet workforce.

### Driver Dashboard (Web)
- **Frictionless Authentication**: Custom email and password login utilizing secure HTTP-only JWT cookies.
- **Live Trip Tracking**: Initiate trips and continuously stream high-accuracy GPS coordinates (`latitude`, `longitude`, `accuracy`, `speed`, `heading`) directly from the browser to the SAP HANA database.
- **Interactive Route Mapping**: Visualizes the live trip path in real-time using Leaflet.js and OpenStreetMap.
- **Performance Analytics**: Live performance metrics evaluating GPS accuracy, trip completion rates, backend database ingestion latencies, and client-side update latencies.

### Fleet Driver App (Android — Capacitor)
- **Native Android Experience**: A dedicated Capacitor-based mobile app built with Vite and Tailwind CSS, compiled into a native Android APK.
- **Persistent Authentication**: JWT Bearer token stored securely via Capacitor Preferences, surviving app restarts — no re-login required.
- **Native GPS Tracking**: Leverages the Capacitor Geolocation plugin for high-accuracy native GPS (not browser-based), including background position streaming.
- **One-Tap Trip Flow**: Minimalist UI — drivers start/stop trips with a single tap. GPS status and last sync time are shown in real time.
- **Session Resumption**: On app relaunch, automatically detects and resumes any active trip without manual intervention.
- **Unified Backend**: All location points from the mobile app are written to the same SAP HANA tables as the web dashboard, with `source: 'capacitor-geolocation'` for traceability.
- **Synchronized with Web**: Fleet Admins see mobile driver locations, routes, and metrics in the web dashboard in real time — no separate backend needed.

---

## 🏗️ Architecture & Technology Stack

### Backend
| Component | Technology |
|-----------|------------|
| Framework | SAP Cloud Application Programming Model (CAP) — Node.js |
| Database | SAP HANA Cloud (Production) / SQLite (Local Development) |
| Authentication | XSUAA (Admin SSO) + bcryptjs/jsonwebtoken (Driver JWT) |
| Deployment | SAP BTP Cloud Foundry via `mta.yaml` |

### Web Frontend
| Component | Technology |
|-----------|------------|
| UI Framework | SAPUI5 (Freestyle Application) |
| Mapping Engine | Leaflet.js + OpenStreetMap |
| Styling | Custom CSS with SAP Fiori Design Language |

### Mobile App
| Component | Technology |
|-----------|------------|
| Runtime | Capacitor 8 (Native Android WebView bridge) |
| Build Tool | Vite 8 |
| Styling | Tailwind CSS 4 |
| Geolocation | `@capacitor/geolocation` (Native GPS) |
| Storage | `@capacitor/preferences` (Secure token persistence) |
| HTTP | `@capacitor/core` with CapacitorHttp plugin (Native HTTP) |

---

## 📂 Project Structure

```text
Location_Tracker/
├── app/
│   ├── locationtracker/          # SAPUI5 Web Frontend (Admin + Driver Dashboards)
│   │   ├── webapp/
│   │   │   ├── controller/       # UI logic (App.controller.js)
│   │   │   ├── view/             # XML Views for Admin and Driver Dashboards
│   │   │   ├── fragment/         # Reusable UI fragments (e.g., Add Driver Dialog)
│   │   │   └── css/              # Custom styling
│   │   └── dist/                 # Production build output
│   └── router/                   # SAP BTP Approuter configuration
├── driver-app/                   # Capacitor Native Android Driver App
│   ├── src/
│   │   ├── main.js               # App entry point (Login, Dashboard, Trip, Tracking)
│   │   ├── config.js             # API base URL and timing constants
│   │   ├── style.css             # Tailwind CSS entry
│   │   └── assets/               # Static assets
│   ├── android/                  # Generated Android Studio project (Gradle)
│   ├── capacitor.config.json     # Capacitor configuration (appId, plugins)
│   ├── tailwind.config.js        # Tailwind CSS configuration
│   └── package.json              # Vite + Capacitor dependencies
├── db/
│   └── schema.cds                # CDS entity models (Admins, Drivers, Trips, LocationPoints)
├── srv/
│   ├── tracker_service.cds       # OData service definition with XSUAA role restrictions
│   └── tracker_service.js        # Custom OData handlers (Admin driver management)
├── server.js                     # Express.js server extension (Driver Auth, Metrics, Map APIs)
├── mta.yaml                      # Multi-Target Application deployment descriptor
└── package.json                  # Root Node.js dependencies and run scripts
```

---

## 🔒 Security & Authentication Deep Dive

The platform employs a sophisticated multi-surface authentication model:

### Web Application
1. **Auth Chooser**: On a fresh session, users land on an Auth Chooser page to select their role.
2. **Admin Flow (RBAC)**: Redirects to SAP XSUAA. Upon successful login, the Approuter forwards the JWT token to the backend, unlocking the strictly gated `@requires: 'FleetAdmin'` OData endpoints.
3. **Driver Flow (Web)**: A custom Express route (`/drivers/login`) authenticates the driver's password (hashed securely via `bcryptjs` and stored in HANA) and issues a custom JWT.
4. **XSS Mitigation**: The custom Driver JWT is delivered strictly via an `httpOnly`, `Secure`, `SameSite=Strict` cookie, making it inaccessible to malicious JavaScript.
5. **CSRF Protection**: Native SAPUI5 CSRF protection (`csrfProtection: true` in `xs-app.json`) is enabled for Admins. For Drivers, a custom token exchange mechanism requires an `x-driver-csrf-token` header on all POST requests.

### Mobile App
6. **Bearer Token Auth**: The mobile app sends `{ mobile: true }` during login. The server responds with the raw JWT in the response body (in addition to the cookie). The app stores it securely via `@capacitor/preferences` and attaches it as a `Bearer` token in the `Authorization` header on every subsequent request.
7. **CSRF on Mobile**: The CSRF token is also persisted in Preferences and sent via the `x-driver-csrf-token` header on all POST requests.
8. **Session Resumption**: On cold start, the app calls `/drivers/me` with the stored Bearer token. If valid, the dashboard is rendered immediately and any active trip is resumed without re-authentication.
9. **Auto-Logout on Expiry**: If the server returns `401` or `403`, the app automatically clears stored credentials and redirects to the login screen.

### Shared
10. **IDOR Prevention**: The backend strictly validates that drivers can only modify or stop their *own* trips by matching the requested `tripId` against their encoded JWT `driverId`.
11. **Dual Token Resolution**: `server.js` checks the `Authorization: Bearer` header first (for mobile), then falls back to the `driver_token` cookie (for web). This allows both surfaces to authenticate against the same endpoints seamlessly.

---

## 🛠️ Local Development Setup

### Web Application (CAP Backend + SAPUI5 Frontend)

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

### Mobile App (Capacitor Android)

1. **Install Dependencies:**
   ```bash
   cd driver-app
   npm install
   ```

2. **Configure the Backend URL:**
   Edit `driver-app/src/config.js` and set `API_BASE` to your backend URL:
   ```js
   export const API_BASE = "https://your-btp-app.cfapps.region.hana.ondemand.com";
   ```

3. **Build the Web Assets:**
   ```bash
   npm run build
   ```

4. **Sync with Android Project:**
   ```bash
   npx cap sync android
   ```

5. **Open in Android Studio:**
   ```bash
   npx cap open android
   ```
   Then build and run on an emulator or physical device from Android Studio.

> **Tip:** During development, use `npm run dev` for hot-reload in the browser, then `npm run build && npx cap sync android` when ready to test on device.

---

## ☁️ Deployment to SAP BTP Cloud Foundry

The web application is fully configured for SAP BTP via the `mta.yaml` descriptor.

1. **Build the MTA Archive:**
   ```bash
   mbt build
   ```
2. **Deploy to Cloud Foundry:**
   ```bash
   cf deploy mta_archives/locationtracker_1.0.0.mtar
   ```

> **Note:** The Capacitor Android app is distributed separately as an APK. It connects to the deployed BTP backend via the URL configured in `driver-app/src/config.js`. No additional BTP configuration is required — the same `server.js` endpoints serve both web and mobile clients.

---

## 📊 Database & Data Model

The application relies on a normalized CDS data model (`db/schema.cds`) optimized for SAP HANA Cloud:

| Entity | Purpose |
|--------|---------|
| `Admins` | Fleet manager profiles (linked to XSUAA identities) |
| `Drivers` | Driver profiles with securely hashed passwords (`bcryptjs`) |
| `Trips` | Active / Completed / Paused trips linked to drivers |
| `LocationPoints` | High-frequency geolocation pings linked to trips |
| `MetricSnapshots` | Historical metric capture points for analytics |
| `DriverSessions` | Optional stateful session tracking (JWT-based auth is primary) |
| `Vehicles` | Vehicle registry with type, model, and fuel type |

### Data Flow
```
Mobile App (Capacitor GPS)  ──►  /drivers/recordLocation  ──►  tracker.LocationPoints
Browser (navigator.geolocation)  ──►  /drivers/recordLocation  ──►  tracker.LocationPoints
                                                                          │
Fleet Admin Dashboard  ◄──  /tracker/driverMetrics/:id  ◄──  Aggregated via CDS QL
```

**Performance Optimization**: By leveraging SAP HANA's in-memory, columnar engine, the application aggregates massive volumes of `LocationPoints` (calculating metrics like *Average Session Duration*, *Average GPS Accuracy*, and *Backend Ingest Latency*) directly at the database layer via CDS QL. This prevents the Node.js backend from being bottlenecked by large data payloads during real-time dashboard refreshes.

---

## 🤝 Contribution Guidelines

When making modifications, please ensure that:
- Any new custom REST endpoints for drivers are added to `server.js` and wrapped with the `requireDriverAuth` middleware.
- Admin management endpoints remain in `srv/tracker_service.cds` to leverage native XSUAA protections.
- Database queries across raw endpoints utilize case-insensitive column mappings (e.g., `trip.ID || trip.id || trip.Id`) to maintain compatibility between local SQLite and production SAP HANA environments.
- Mobile app changes are tested on a physical device — emulator GPS simulation may not reflect real-world accuracy or latency.
- The `source` field on `LocationPoints` should correctly identify the origin (`browser-geolocation` or `capacitor-geolocation`) for traceability.

---

## 📄 License

This project is licensed under the terms specified in the [LICENSE](LICENSE) file.
