# Driver Self-Registration System for FleetTracker

This document describes the comprehensive driver self-registration system implemented in the FleetTracker application.

## Overview

The driver self-registration system allows new drivers to create accounts and submit registration requests. Fleet admins can then review pending registrations, approve qualified drivers, or reject them with reasons. The system includes client-side validation, password strength checking, and document upload capabilities.

## Features

### 1. Driver Self-Registration
- **Public Registration Endpoint**: Drivers can register without authentication
- **Comprehensive Form Fields**:
  - Full Name (required, string)
  - Email (required, unique, email format validation)
  - Phone (required, string)
  - License Number (required, string)
  - License Expiry Date (required, date picker, must be future date)
  - Vehicle ID (required, string)
  - Document Upload (PDF/Image, max 5MB)
  - Password (required, with strength validation)
  - Confirm Password (required, must match)
  - Terms & Conditions (checkbox, required)

### 2. Password Security
- **Minimum Requirements**:
  - At least 8 characters
  - 1 uppercase letter (A-Z)
  - 1 lowercase letter (a-z)
  - 1 number (0-9)
  - 1 special character (!@#$%^&*()_+-=[]{}...etc)
- **Visual Feedback**: Real-time password strength indicator
- **Password Matching**: Confirmation validation with visual feedback
- **Show/Hide Toggle**: Toggle password visibility

### 3. Form Validation
- **Client-side Validation**:
  - Email format validation
  - Password strength validation
  - Password match validation
  - File size and type validation (PDF, JPG, PNG, max 5MB)
  - Date validation (license expiry must be future date)
- **Server-side Validation**: All fields re-validated on backend
  - Email uniqueness check
  - Password strength re-verification
  - File type validation

### 4. Registration Status Workflow
- **PENDING**: Initial status after registration submission
- **APPROVED**: Admin approves the registration, account becomes active
- **REJECTED**: Admin rejects the registration with reason
- **ACTIVE**: Approved drivers can login

### 5. Admin Dashboard
- **Pending Registrations List**: View all pending driver registrations
- **Approve Registration**: Assign admin and activate driver account
- **Reject Registration**: Reject with mandatory reason explanation
- **View Details**: Inspect full registration details and documents
- **Document Verification**: Access uploaded driver documents

## File Structure

```
FleetTracker/
├── db/
│   └── schema.cds              # Database schema with Driver entity
├── srv/
│   ├── tracker_service.cds     # Service definitions with registration endpoints
│   └── tracker_service.js      # Implementation of registration handlers
└── driver-app/
    └── src/
        ├── main.js             # Main app with registration UI
        ├── registration.js     # Registration utilities and validation
        ├── admin.js            # Admin dashboard functions
        └── config.js           # API configuration
```

## Backend Implementation

### CDS Service Definitions (tracker_service.cds)

```cds
type RegistrationRequest {
  fullName        : String(120);
  email           : String(255);
  phone           : String(40);
  licenseNumber   : String(80);
  licenseExpiry   : Date;
  vehicleId       : String(80);
  password        : String(255);
  confirmPassword : String(255);
  termsAccepted   : Boolean;
}

type RegistrationResponse {
  success        : Boolean;
  message        : String;
  registrationId : UUID;
  email          : String;
}

action registerDriver(req : RegistrationRequest) returns RegistrationResponse;
action approveDriverRegistration(driverId : UUID) returns Drivers;
action rejectDriverRegistration(driverId : UUID, reason : String) returns String;
function getPendingRegistrations() returns array of PendingRegistration;
```

### Service Handlers (tracker_service.js)

#### 1. registerDriver Handler
```javascript
this.on("registerDriver", async (req) => {
  // Validation: all fields required, email unique, password strength
  // Hash password using bcryptjs
  // Create driver record with registrationStatus = 'PENDING'
  // Return success response with registration ID
});
```

**Endpoint**: `POST /tracker/registerDriver`

**Request Body**:
```json
{
  "fullName": "John Doe",
  "email": "john.doe@example.com",
  "phone": "+1 (555) 123-4567",
  "licenseNumber": "DL123456",
  "licenseExpiry": "2026-12-31",
  "vehicleId": "VEH-001",
  "password": "SecurePass123!",
  "confirmPassword": "SecurePass123!",
  "termsAccepted": true
}
```

**Response**:
```json
{
  "success": true,
  "message": "Registration submitted successfully. Please wait for admin approval.",
  "registrationId": "uuid-here",
  "email": "john.doe@example.com"
}
```

#### 2. getPendingRegistrations Handler
Returns all drivers with registrationStatus = 'PENDING'

**Endpoint**: `GET /tracker/getPendingRegistrations` (Requires FleetAdmin role)

**Response**:
```json
[
  {
    "ID": "uuid-here",
    "fullName": "John Doe",
    "email": "john.doe@example.com",
    "phone": "+1 (555) 123-4567",
    "licenseNumber": "DL123456",
    "licenseExpiry": "2026-12-31",
    "vehicleId": "VEH-001",
    "documentUrl": "url-to-document",
    "registrationStatus": "PENDING",
    "createdAt": "2026-06-25T10:30:00.000Z",
    "submittedBy": "john.doe@example.com"
  }
]
```

#### 3. approveDriverRegistration Handler
Approves a pending registration and activates the driver account

**Endpoint**: `POST /tracker/approveDriverRegistration` (Requires FleetAdmin role)

**Request Body**:
```json
{
  "driverId": "uuid-here"
}
```

**Updates**:
- Sets `registrationStatus` to 'APPROVED'
- Sets `isActive` to true
- Assigns admin to the driver
- Email notification sent to driver (TODO)

#### 4. rejectDriverRegistration Handler
Rejects a pending registration with a reason

**Endpoint**: `POST /tracker/rejectDriverRegistration` (Requires FleetAdmin role)

**Request Body**:
```json
{
  "driverId": "uuid-here",
  "reason": "Invalid license number format"
}
```

**Updates**:
- Sets `registrationStatus` to 'REJECTED'
- Email notification sent to driver with reason (TODO)

## Frontend Implementation

### Registration Form (main.js - renderRegistration function)

The registration form is rendered in the driver app with the following features:

1. **Multi-step Validation**: Client-side validation before submission
2. **Password Strength Meter**: Visual feedback as user types
3. **Password Confirmation**: Automatic matching validation with visual indicator
4. **File Upload**: Document verification file selection
5. **Error Messages**: Clear error messages for each validation failure
6. **Loading States**: Button shows "Registering..." during submission
7. **Success Message**: Confirmation message redirects to login after 3 seconds

### Registration.js Module

Utility functions for form validation:
- `isValidEmail()`: Email format validation
- `validatePasswordStrength()`: Password strength scoring
- `validateRegistrationForm()`: Complete form validation
- `validateFileUpload()`: File size and type validation
- `registerDriver()`: API call to register

### Admin Dashboard (admin.js Module)

Functions for admin pending registration management:
- `fetchPendingRegistrations()`: Get all pending registrations
- `approveDriverRegistration()`: Approve a driver
- `rejectDriverRegistration()`: Reject with reason
- `renderPendingRegistrationsTable()`: Display registrations table
- `renderRegistrationDetailModal()`: Show detailed view
- `renderRejectReasonModal()`: Collect rejection reason

## Database Schema

### Driver Entity
```cds
entity Drivers : cuid, managed {
  name               : String(120);
  email              : String(255) @assert.unique;
  passwordHash       : String(255);
  vehicleId          : String(80);
  phone              : String(40);
  isActive           : Boolean default true;
  admin              : Association to Admins;
  registrationStatus : String(20) enum { 
    PENDING; 
    APPROVED; 
    REJECTED; 
  } default 'PENDING';
  licenseNumber      : String(80);
  licenseExpiry      : Date;
  documentUrl        : String(500);
  trips              : Composition of many Trips on trips.driver = $self;
  sessions           : Composition of many DriverSessions on sessions.driver = $self;
}
```

## Security Considerations

### 1. Password Security
- Passwords hashed using bcryptjs with 12 salt rounds
- Never stored in plain text
- Strong password requirements enforced

### 2. Email Validation
- Unique email constraint at database level
- Format validation on both client and server
- Case-insensitive comparison

### 3. Input Validation
- All inputs validated on client and server
- HTML escaping to prevent XSS
- File type and size validation

### 4. Authentication
- JWT tokens for authenticated requests
- Admin-only endpoints protected with @requires: 'FleetAdmin'
- Public registration endpoint has rate limiting (TODO)

### 5. Document Handling
- File size limited to 5MB
- Only PDF, JPG, PNG allowed
- Should be stored securely with virus scanning (TODO)

## API Integration

### Configuration (config.js)
```javascript
export const API_BASE = "https://deployed-app-url";
```

### Authentication
Requests include:
- Authorization header with JWT token
- CSRF token for protection
- Content-Type: application/json

## Testing

### Manual Testing Steps

#### 1. Driver Registration
1. Go to login page
2. Click "Register here"
3. Fill in all form fields
4. Verify real-time validation feedback
5. Test password strength meter
6. Submit form
7. Verify success message and redirect

#### 2. Email Validation
- Try registering with existing email (should fail)
- Try invalid email format (should fail)
- Verify email uniqueness error message

#### 3. Password Validation
- Test weak passwords (should show in strength meter)
- Try mismatched passwords (should show error)
- Test strong password (all requirements met)

#### 4. File Upload
- Try file > 5MB (should fail)
- Try non-PDF/JPG/PNG file (should fail)
- Upload valid PDF/JPG/PNG (should succeed)

#### 5. Admin Approval
- Login as admin
- View pending registrations
- Approve a registration
- Verify driver becomes active
- Login as approved driver

#### 6. Admin Rejection
- Login as admin
- View pending registrations
- Reject with reason
- Verify driver status changed to REJECTED

### Unit Tests (To Be Implemented)
- Password strength validation
- Email format validation
- File upload validation
- Form submission
- API response handling

## Future Enhancements

### Planned Features
1. **Email Notifications**
   - Admin notification when new registration submitted
   - Driver notification on approval/rejection
   - Include rejection reason in email

2. **Document Upload Enhancement**
   - Integration with cloud storage (Azure Blob, AWS S3)
   - Virus scanning for uploaded files
   - Automatic document verification

3. **Two-Factor Authentication**
   - SMS or email OTP verification
   - Authenticator app support

4. **Advanced Admin Features**
   - Bulk approve/reject registrations
   - Export registrations list
   - Search and filter registrations
   - Comments on registrations

5. **Rate Limiting**
   - Prevent abuse of registration endpoint
   - IP-based rate limiting

6. **Audit Logging**
   - Log all registration activities
   - Track approvals and rejections

7. **Document Verification**
   - OCR for automatic license verification
   - Biometric matching

8. **SMS Verification**
   - Phone number verification via SMS
   - OTP confirmation

## Troubleshooting

### Common Issues

#### 1. Registration Failed - Email Already Registered
**Cause**: Email already exists in database
**Solution**: Use a different email or reset password if account was created

#### 2. Password Not Strong Enough
**Cause**: Password doesn't meet strength requirements
**Solution**: Add uppercase, lowercase, number, and special character

#### 3. License Expiry Date Invalid
**Cause**: Date is in the past
**Solution**: Enter a future date for license expiry

#### 4. File Upload Failed
**Cause**: File too large or wrong format
**Solution**: Use PDF, JPG, or PNG file under 5MB

#### 5. Pending Registrations List Empty
**Cause**: All registrations have been processed or approved
**Solution**: Normal state - wait for new registrations or view approved drivers

## Performance Considerations

### Optimization Strategies
1. **Database Indexing**: Add indexes on email field for faster lookups
2. **Caching**: Cache pending registrations list (short TTL)
3. **Pagination**: Implement pagination for large registration lists
4. **Lazy Loading**: Load documents on demand, not in list

### Expected Performance
- Registration submission: < 2 seconds
- Pending list load: < 1 second (with caching)
- Approval/Rejection: < 1 second

## Compliance

### Data Privacy
- Personal data (email, phone) only used for registration
- Compliance with data protection regulations (GDPR, etc.)
- Secure storage of sensitive information

### Audit Trail
- All registration activities logged
- Approval/rejection tracked with timestamps
- Admin identification on each action

## Dependencies

### Backend
- `@sap/cds`: ^9.9.0 - CAP framework
- `bcryptjs`: ^2.4.3 - Password hashing
- `express`: ^4.22.1 - Web server

### Frontend
- `@capacitor/preferences`: ^8.0.1 - Local storage
- `@capacitor/geolocation`: ^8.2.0 - GPS (for driver app)
- Tailwind CSS: ^4.3.0 - Styling

## Deployment

### Prerequisites
- Node.js 16+
- npm 7+
- CAP CLI installed

### Installation Steps
```bash
cd /path/to/FleetTracker
npm install
```

### Running Locally
```bash
npm start
# Driver app: http://localhost:3000/driver-app
# Admin app: http://localhost:3000/app
```

### Building for Production
```bash
npm run build
# Deploy to Cloud Foundry or other hosting
```

## Support

For issues or questions about the registration system:
1. Check this README and troubleshooting section
2. Review error messages in browser console
3. Check server logs for backend errors
4. Create an issue in the repository

## License

Part of the FleetTracker project - See LICENSE file
