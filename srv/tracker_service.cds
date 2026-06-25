using tracker from '../db/schema';

@requires: 'authenticated-user'
service TrackerService @(path : '/tracker') {
  type UserContext {
    email    : String;
    name     : String;
    isAdmin  : Boolean;
    isDriver : Boolean;
    adminId  : UUID;
    driverId : UUID;
  }

  @restrict: [
    { grant: 'READ', to: 'FleetAdmin' },
    { grant: ['CREATE', 'UPDATE', 'DELETE'], to: 'FleetAdmin' }
  ]
  entity Admins as projection on tracker.Admins;

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] }
  ]
  entity Drivers as projection on tracker.Drivers {
    ID,
    createdAt,
    createdBy,
    modifiedAt,
    modifiedBy,
    name,
    email,
    vehicleId,
    phone,
    isActive,
    registrationStatus,
    licenseNumber,
    licenseExpiry,
    documentUrl,
    virtual activityStatus : String(20),
    admin,
    trips
  };

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] }
  ]
  entity Trips as projection on tracker.Trips;

  @restrict: [
    { grant: 'READ', to: ['Driver', 'FleetAdmin'] }
  ]
  entity LocationPoints as projection on tracker.LocationPoints;

  @restrict: [
    { grant: '*', to: 'FleetAdmin' }
  ]
  entity Vehicles as projection on tracker.Vehicles;

  @restrict: [
    { grant: 'READ', to: 'FleetAdmin' }
  ]
  entity MetricSnapshots as projection on tracker.MetricSnapshots;

  function me() returns UserContext;


  @requires: 'FleetAdmin'
  function listDrivers() returns array of Drivers;

  @requires: 'FleetAdmin'
  action deleteDriver(driverId : UUID) returns Drivers;

  @requires: 'FleetAdmin'
  action reactivateDriver(driverId : UUID) returns Drivers;

  @requires: 'FleetAdmin'
  action permanentlyDeleteDriver(driverId : UUID) returns String;

  @requires: 'Driver'
  action startTrip(title : String) returns Trips;

  @requires: 'Driver'
  action stopTrip(tripId : UUID) returns Trips;

  @requires: 'Driver'
  action recordLocation(
    tripId      : UUID,
    latitude    : Decimal(9, 6),
    longitude   : Decimal(9, 6),
    accuracy    : Decimal(9, 2),
    altitude    : Decimal(9, 2),
    speed       : Decimal(9, 2),
    heading     : Decimal(9, 2),
    recordedAt  : Timestamp,
    source      : String(30)
  ) returns LocationPoints;

  @requires: 'Driver'
  function activeTrip() returns Trips;

  @requires: 'FleetAdmin'
  function metrics() returns TrackerMetrics;

  // Driver Self-Registration Endpoints
  type RegistrationRequest {
    fullName      : String(120);
    email         : String(255);
    phone         : String(40);
    licenseNumber : String(80);
    licenseExpiry : Date;
    vehicleId     : String(80);
    password      : String(255);
    confirmPassword : String(255);
    termsAccepted : Boolean;
  }

  type RegistrationResponse {
    success        : Boolean;
    message        : String;
    registrationId : UUID;
    email          : String;
  }

  type PendingRegistration {
    ID            : UUID;
    fullName      : String(120);
    email         : String(255);
    phone         : String(40);
    licenseNumber : String(80);
    licenseExpiry : Date;
    vehicleId     : String(80);
    documentUrl   : String(500);
    registrationStatus : String(20);
    createdAt     : Timestamp;
    submittedBy   : String(255);
  }

  // Public endpoint for driver registration (no auth required)
  action registerDriver(req : RegistrationRequest) returns RegistrationResponse;

  // Admin endpoint to approve pending registrations
  @requires: 'FleetAdmin'
  action approveDriverRegistration(driverId : UUID) returns Drivers;

  // Admin endpoint to reject pending registrations
  @requires: 'FleetAdmin'
  action rejectDriverRegistration(driverId : UUID, reason : String) returns String;

  // Admin endpoint to get pending registrations
  @requires: 'FleetAdmin'
  function getPendingRegistrations() returns array of PendingRegistration;
}

type TrackerMetrics {
  generatedAt          : Timestamp;
  totalTrips           : Integer;
  completedTrips       : Integer;
  completionRate       : Decimal(5, 2);
  totalPoints          : Integer;
  avgPointsPerTrip     : Decimal(9, 2);
  avgGpsAccuracy       : Decimal(9, 2);
  avgSessionDurationMs : Decimal(15, 2);
  ingestAttempts       : Integer;
  ingestSuccess        : Integer;
  ingestFailure        : Integer;
  ingestSuccessRate    : Decimal(5, 2);
  avgIngestLatencyMs   : Decimal(9, 2);
}
