namespace tracker;
using { cuid, managed } from '@sap/cds/common';
entity Admins : cuid, managed {
  name    : String(120);
  email   : String(255) @assert.unique;
  drivers : Composition of many Drivers on drivers.admin = $self;
}
entity Drivers : cuid, managed {
  name               : String(120);
  email              : String(255) @assert.unique;
  passwordHash       : String(255);
  vehicleId          : String(80);
  phone              : String(40);
  isActive           : Boolean default true;
  admin              : Association to Admins;
  registrationStatus : String(20) enum { PENDING; APPROVED; REJECTED; } default 'PENDING';
  licenseNumber      : String(80);
  licenseExpiry      : Date;
  documentUrl        : String(500);
  trips              : Composition of many Trips on trips.driver = $self;
  sessions           : Composition of many DriverSessions on sessions.driver = $self;
}

// New FreightOrders entity (declared before Trips to satisfy forward references)
entity FreightOrders : cuid, managed {
  orderNumber       : String(40);
  admin             : Association to Admins;
  truck             : Association to Trucks;
  driver            : Association to Drivers;
  trip              : Association to Trips;
  origin            : String(200);
  destination       : String(200);
  plannedDeparture  : Timestamp;
  plannedArrival    : Timestamp;
  actualArrival     : Timestamp;
  status            : String(20) enum { PLANNED; DISPATCHED; DELIVERED; CANCELLED; } default 'PLANNED';
  checkpointCount   : Integer default 0;
}

entity GatePasses : cuid, managed {
  freightOrder  : Association to FreightOrders;
  truck         : Association to Trucks;
  driver        : Association to Drivers;
  gateOfficer   : String(120);
  direction     : String(3) enum { OUT; INN; };
  passedAt      : Timestamp;
  remarks       : String(300);
  status        : String(20) enum { PENDING; APPROVED; REJECTED; } default 'PENDING';
}

entity CheckpointReadings : cuid, managed {
  freightOrder  : Association to FreightOrders not null;
  checkpointNo  : Integer;
  fuelLitres    : Decimal(7,2);
  tyreFL        : Decimal(5,1);
  tyreFR        : Decimal(5,1);
  tyreRL        : Decimal(5,1);
  tyreRR        : Decimal(5,1);
  odometerKm    : Decimal(9,1);
  driverNote    : String(500);
  latitude      : Decimal(9,6);
  longitude     : Decimal(9,6);
  capturedAt    : Timestamp;
}

entity VehicleMetrics : cuid, managed {
  truck         : Association to Trucks not null;
  trip          : Association to Trips;
  fuelLitres    : Decimal(7,2);
  tyreFL        : Decimal(5,1);
  tyreFR        : Decimal(5,1);
  tyreRL        : Decimal(5,1);
  tyreRR        : Decimal(5,1);
  engineTempC   : Decimal(5,1);
  odometerKm    : Decimal(9,1);
  source        : String(20) enum { MANUAL; OBD; SCHEDULED; } default 'MANUAL';
  capturedAt    : Timestamp;
}

entity AlertThresholds : cuid, managed {
  truck         : Association to Trucks;
  admin         : Association to Admins;
  metricType    : String(30);
  warningAt     : Decimal(9,2);
  criticalAt    : Decimal(9,2);
}

entity AlertEvents : cuid, managed {
  truck         : Association to Trucks;
  trip          : Association to Trips;
  metricType    : String(30);
  severity      : String(10) enum { WARNING; CRITICAL; };
  value         : Decimal(9,2);
  threshold     : Decimal(9,2);
  isRead        : Boolean default false;
  firedAt       : Timestamp;
}

entity Trips : cuid, managed {
  title        : String(120);
  driver       : Association to Drivers;
  startedAt    : Timestamp;
  expectedEndAt: Timestamp; // optional field to mark expected delivery/arrival time
  endedAt      : Timestamp;
  status       : String(20) enum {
    ACTIVE;
    COMPLETED;
    PAUSED;
  } default 'ACTIVE';
  checkpointCount : Integer default 0;
  freightOrder    : Association to FreightOrders;
  points       : Composition of many LocationPoints on points.trip = $self;
}

entity LocationPoints : cuid, managed {
  trip       : Association to Trips not null;
  latitude   : Decimal(9, 6);
  longitude  : Decimal(9, 6);
  accuracy   : Decimal(9, 2);
  altitude   : Decimal(9, 2);
  speed      : Decimal(9, 2);
  heading    : Decimal(9, 2);
  recordedAt : Timestamp;
  source     : String(30);
}

entity Vehicles : cuid, managed {
  vehicle_number      : Integer;
  type                : String;
  model               : Integer;
  registration_number : Integer;
  fuel_type           : String(20) enum {
    PETROL;
    DIESEL;
  } default 'PETROL';
  status              : String(20) enum {
    ACTIVE;
    DEACTIVATED;
  } default 'DEACTIVATED';
}

// New Trucks entity for truck management and live-tracking
entity Trucks : cuid, managed {
  truckNumber         : Integer;
  model               : String(120);
  registrationNumber  : String(80);
  fuelType            : String(20) enum {
    PETROL;
    DIESEL;
    ELECTRIC;
  } default 'DIESEL';
  status              : String(30) enum {
    ACTIVE;
    IN_MAINTENANCE;
    IDLE;
  } default 'IDLE';
  latitude            : Decimal(9,6);
  longitude           : Decimal(9,6);
  assignedDriver      : Association to Drivers;
  admin               : Association to Admins not null;
}

entity MetricSnapshots : cuid, managed {
  capturedAt           : Timestamp;
  totalTrips           : Integer;
  completedTrips       : Integer;
  completionRate       : Decimal(5, 2);
  totalPoints          : Integer;
  avgPointsPerTrip     : Decimal(9, 2);
  avgGpsAccuracy       : Decimal(9, 2);
  avgSessionDurationMs : Decimal(15, 2);
  ingestSuccessRate    : Decimal(5, 2);
  avgIngestLatencyMs   : Decimal(9, 2);
}

// JWT-based auth does not use this entity; kept for optional stateful sessions.
entity DriverSessions : cuid {
  driver     : Association to Drivers not null;
  token      : String(255) not null;
  expiresAt  : Timestamp not null;
  createdAt  : Timestamp not null;
}
