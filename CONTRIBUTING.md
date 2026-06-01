# Contributing to Location Tracker

First off, thank you for considering contributing to Location Tracker! It's people like you that make this system better for fleet managers and drivers alike.

## Code of Conduct
By participating in this project, you are expected to uphold our Code of Conduct. Please be respectful and professional in all your interactions.

## Development Setup
Please refer to the `README.md` for instructions on how to set up the project locally. For local development, we heavily rely on the in-memory SQLite database provided by SAP CAP (`@cap-js/sqlite`) before pushing changes to the production SAP HANA Cloud.

## Core Architectural Rules 

When contributing to this codebase, you **must** adhere to the following conventions to ensure stability across both SQLite and HANA:

### 1. Dual Authentication Separation
Our application uses two distinct authentication methods. Never mix them.
- **Admin Endpoints**: Must be defined in `srv/tracker_service.cds` and secured via `@requires: 'FleetAdmin'`. This ensures native XSUAA integration.
- **Driver Endpoints**: Must be defined in the custom Express layer (`server.js`) and secured using the custom `requireDriverAuth` middleware. Do **not** expose driver endpoints via XSUAA, as drivers log in via email/password.

### 2. Database Mapping and HANA Compatibility
SAP HANA automatically transforms database column names to **UPPERCASE**, while SQLite maintains their exact definition casing. 
If you are writing raw SQL queries using `db.run()` or `SELECT.from()` inside `server.js`, you **must** implement case-insensitive fallbacks when extracting data from the results.

**Incorrect:**
```javascript
const tripId = trip.ID;
const started = trip.startedAt;
```

**Correct:**
```javascript
const tripId = trip.ID || trip.id || trip.Id;
const started = trip.startedAt || trip.STARTEDAT;
```
Failure to include uppercase fallbacks will cause `undefined` errors in production, even if the code works perfectly on your local machine.

### 3. Session Intents & UX
To ensure drivers and admins aren't improperly auto-logged into the system when forcefully refreshing or opening the app natively, we utilize session gates. 
If you add a new role or auth flow in `App.controller.js`, ensure you implement an `Intent` flag in `window.sessionStorage` (e.g., `adminLoginIntent`, `driverLoginIntent`) to gate the auto-login mechanics.

## Submitting Pull Requests
1. Fork the repository and create your branch from `main`.
2. If you've added code that should be tested, add tests.
3. Ensure your code passes all linting and build checks (`npm run build`).
4. Issue a PR with a comprehensive description of the changes.

## Bug Reports
If you find a bug, please create an Issue and include:
- A description of the issue.
- Steps to reproduce.
- Any relevant logs, specifically checking the browser console and the Cloud Foundry app logs.

Thank you for contributing!
