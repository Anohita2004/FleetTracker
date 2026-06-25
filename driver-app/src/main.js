import { API_BASE } from './config.js';
import { Preferences } from '@capacitor/preferences';
import { Geolocation } from '@capacitor/geolocation';

const appDiv = document.getElementById('app');

let watchId = null;
let activeTripId = null;

// Helper to make authenticated API calls
async function authFetch(endpoint, options = {}) {
  const { value: token } = await Preferences.get({ key: 'driver_token' });
  const { value: csrf } = await Preferences.get({ key: 'csrf_token' });
  
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (csrf) headers['x-driver-csrf-token'] = csrf;

  const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
  
  // If token is invalid, force logout
  if (res.status === 401 || res.status === 403) {
    await Preferences.remove({ key: 'driver_token' });
    renderLogin();
    throw new Error("Authentication failed");
  }
  
  return res;
}

// 1. Check if the user is already logged in
async function checkLogin() {
  const { value } = await Preferences.get({ key: 'driver_token' });
  if (value) {
    try {
      // Verify token and get driver info
      const res = await authFetch('/drivers/me');
      const data = await res.json();
      
      // Check for an active trip to restore state
      const tripRes = await authFetch('/drivers/activeTrip');
      const tripData = await tripRes.json();
      
      if (tripData && tripData.ID) {
        activeTripId = tripData.ID;
        // Resume tracking if there is an active trip
        startTracking();
      }
      
      renderDashboard(data.driver);
    } catch (e) {
      console.error(e);
      renderLogin();
    }
  } else {
    renderLogin();
  }
}

// 2. The Login Screen UI
function renderLogin() {
  appDiv.innerHTML = `
    <div class="flex-1 flex flex-col justify-center px-6 py-12">
      <div class="sm:mx-auto sm:w-full sm:max-w-sm">
        <h2 class="mt-10 text-center text-3xl font-extrabold text-gray-900 tracking-tight">Fleet Driver</h2>
        <p class="text-center text-sm text-gray-500 mt-2">Sign in to start your trip</p>
      </div>
      <div class="mt-10 sm:mx-auto sm:w-full sm:max-w-sm">
        <form id="loginForm" class="space-y-6">
          <div>
            <label for="email" class="block text-sm font-medium text-gray-900">Email address</label>
            <div class="mt-2">
              <input id="email" name="email" type="email" required class="block w-full rounded-md border-0 py-2.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm px-3">
            </div>
          </div>
          <div>
            <label for="password" class="block text-sm font-medium text-gray-900">Password</label>
            <div class="mt-2">
              <input id="password" name="password" type="password" required class="block w-full rounded-md border-0 py-2.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 sm:text-sm px-3">
            </div>
          </div>
          <div>
            <button type="submit" id="loginBtn" class="flex w-full justify-center rounded-md bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 transition-colors">Sign in</button>
          </div>
        </form>
        <p id="errorMessage" class="mt-4 text-center text-sm text-red-600 hidden font-medium"></p>
        <p class="mt-6 text-center text-sm text-gray-600">
          Don't have an account? 
          <button type="button" id="registerLink" class="text-blue-600 hover:text-blue-700 font-semibold">Register here</button>
        </p>
      </div>
    </div>
  `;

  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('registerLink').addEventListener('click', () => renderRegistration());
}

// Handle login form submission
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('errorMessage');
  const loginBtn = document.getElementById('loginBtn');
  
  try {
    errorMsg.classList.add('hidden');
    loginBtn.textContent = "Signing in...";
    loginBtn.disabled = true;

    const res = await fetch(`${API_BASE}/drivers/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, mobile: true })
    });
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || 'Login failed');
    
    if (data.token) {
      await Preferences.set({ key: 'driver_token', value: data.token });
      if (data.csrfToken) await Preferences.set({ key: 'csrf_token', value: data.csrfToken });
      
      // Pass the driver object directly to dashboard
      renderDashboard(data.driver);
    } else {
      throw new Error('No token returned from server');
    }
  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.classList.remove('hidden');
  } finally {
    loginBtn.textContent = "Sign in";
    loginBtn.disabled = false;
  }
}

// Validate password strength
function validatePasswordStrength(password) {
  const strength = {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasNumber: /\d/.test(password),
    hasSpecial: /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)
  };
  
  strength.isStrong = Object.values(strength).every(v => v === true);
  strength.score = Object.values(strength).filter(v => v === true).length;
  
  return strength;
}

// Render password strength indicator
function renderPasswordStrengthIndicator(containerId, password) {
  const strength = validatePasswordStrength(password);
  const container = document.getElementById(containerId);
  
  if (!container) return;
  
  if (!password) {
    container.innerHTML = '';
    return;
  }
  
  const scoreLabels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const scoreColors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];
  const label = scoreLabels[strength.score - 1] || 'Very Weak';
  const color = scoreColors[strength.score - 1] || 'bg-red-500';
  
  container.innerHTML = `
    <div class="flex items-center justify-between mt-2">
      <div class="text-sm font-medium text-gray-700">Password Strength:</div>
      <div class="text-sm font-semibold ${strength.isStrong ? 'text-green-600' : 'text-red-600'}">${label}</div>
    </div>
    <div class="w-full bg-gray-200 rounded-full h-2 mt-1">
      <div class="${color} h-2 rounded-full transition-all" style="width: ${(strength.score / 5) * 100}%"></div>
    </div>
  `;
}

// Registration form
function renderRegistration() {
  appDiv.innerHTML = `
    <div class="flex-1 flex flex-col justify-center px-6 py-8 overflow-y-auto">
      <div class="sm:mx-auto sm:w-full sm:max-w-md">
        <h2 class="text-center text-3xl font-extrabold text-gray-900 tracking-tight">Driver Registration</h2>
        <p class="text-center text-sm text-gray-500 mt-2">Create your driver account</p>
      </div>
      
      <div class="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <form id="registrationForm" class="space-y-4">
          <!-- Full Name -->
          <div>
            <label for="fullName" class="block text-sm font-medium text-gray-900">Full Name *</label>
            <input id="fullName" name="fullName" type="text" required placeholder="John Doe" class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- Email -->
          <div>
            <label for="regEmail" class="block text-sm font-medium text-gray-900">Email *</label>
            <input id="regEmail" name="email" type="email" required placeholder="driver@example.com" class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- Phone -->
          <div>
            <label for="phone" class="block text-sm font-medium text-gray-900">Phone Number *</label>
            <input id="phone" name="phone" type="tel" required placeholder="+1 (555) 000-0000" class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- License Number -->
          <div>
            <label for="licenseNumber" class="block text-sm font-medium text-gray-900">License Number *</label>
            <input id="licenseNumber" name="licenseNumber" type="text" required placeholder="DL123456" class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- License Expiry Date -->
          <div>
            <label for="licenseExpiry" class="block text-sm font-medium text-gray-900">License Expiry Date *</label>
            <input id="licenseExpiry" name="licenseExpiry" type="date" required class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- Vehicle ID -->
          <div>
            <label for="vehicleId" class="block text-sm font-medium text-gray-900">Vehicle ID *</label>
            <input id="vehicleId" name="vehicleId" type="text" required placeholder="VEH-001" class="mt-2 block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3">
          </div>
          
          <!-- Document Upload -->
          <div>
            <label for="documentUpload" class="block text-sm font-medium text-gray-900">License Document (PDF/Image) *</label>
            <input id="documentUpload" name="document" type="file" accept=".pdf,.jpg,.jpeg,.png" required class="mt-2 block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100">
            <p class="mt-1 text-xs text-gray-500">Max size: 5MB. Accepted: PDF, JPG, PNG</p>
          </div>
          
          <!-- Password -->
          <div>
            <label for="regPassword" class="block text-sm font-medium text-gray-900">Password *</label>
            <div class="relative mt-2">
              <input id="regPassword" name="password" type="password" required placeholder="••••••••" class="block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3 pr-10">
              <button type="button" id="togglePassword" class="absolute right-3 top-2.5 text-gray-500 hover:text-gray-700">
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>
              </button>
            </div>
            <div id="passwordStrength"></div>
            <p class="mt-1 text-xs text-gray-500">At least 8 characters, 1 uppercase, 1 lowercase, 1 number, 1 special character</p>
          </div>
          
          <!-- Confirm Password -->
          <div>
            <label for="confirmPassword" class="block text-sm font-medium text-gray-900">Confirm Password *</label>
            <div class="relative mt-2">
              <input id="confirmPassword" name="confirmPassword" type="password" required placeholder="••••••••" class="block w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3 pr-10">
              <div id="passwordMatch" class="absolute right-3 top-2.5"></div>
            </div>
          </div>
          
          <!-- Terms & Conditions -->
          <div class="flex items-center">
            <input id="termsAccepted" name="termsAccepted" type="checkbox" required class="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded">
            <label for="termsAccepted" class="ml-2 block text-sm text-gray-700">
              I accept the <a href="#" class="text-blue-600 hover:text-blue-700 font-semibold">Terms & Conditions</a> *
            </label>
          </div>
          
          <!-- Submit Button -->
          <div>
            <button type="submit" id="registerBtn" class="flex w-full justify-center rounded-md bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-500 transition-colors">Register</button>
          </div>
          
          <!-- Messages -->
          <div id="regErrorMessage" class="text-center text-sm text-red-600 hidden font-medium"></div>
          <div id="regSuccessMessage" class="text-center text-sm text-green-600 hidden font-medium"></div>
        </form>
        
        <!-- Back to login link -->
        <p class="mt-6 text-center text-sm text-gray-600">
          Already have an account? 
          <button type="button" id="backToLogin" class="text-blue-600 hover:text-blue-700 font-semibold">Sign in</button>
        </p>
      </div>
    </div>
  `;
  
  // Event listeners
  document.getElementById('backToLogin').addEventListener('click', () => renderLogin());
  document.getElementById('registrationForm').addEventListener('submit', handleRegistration);
  document.getElementById('togglePassword').addEventListener('click', togglePasswordVisibility);
  document.getElementById('regPassword').addEventListener('input', (e) => {
    renderPasswordStrengthIndicator('passwordStrength', e.target.value);
    checkPasswordMatch();
  });
  document.getElementById('confirmPassword').addEventListener('input', checkPasswordMatch);
}

function togglePasswordVisibility() {
  const pwInput = document.getElementById('regPassword');
  const confirmInput = document.getElementById('confirmPassword');
  const btn = document.getElementById('togglePassword');
  
  const isPassword = pwInput.type === 'password';
  pwInput.type = isPassword ? 'text' : 'password';
  confirmInput.type = isPassword ? 'text' : 'password';
}

function checkPasswordMatch() {
  const pw = document.getElementById('regPassword').value;
  const confirm = document.getElementById('confirmPassword').value;
  const matchDiv = document.getElementById('passwordMatch');
  
  if (!confirm) {
    matchDiv.innerHTML = '';
    return;
  }
  
  if (pw === confirm) {
    matchDiv.innerHTML = '✓';
    matchDiv.classList.remove('text-red-500');
    matchDiv.classList.add('text-green-500');
  } else {
    matchDiv.innerHTML = '✗';
    matchDiv.classList.remove('text-green-500');
    matchDiv.classList.add('text-red-500');
  }
}

// Handle registration form submission
async function handleRegistration(e) {
  e.preventDefault();
  
  const formData = new FormData(document.getElementById('registrationForm'));
  const fullName = formData.get('fullName');
  const email = formData.get('email');
  const phone = formData.get('phone');
  const licenseNumber = formData.get('licenseNumber');
  const licenseExpiry = formData.get('licenseExpiry');
  const vehicleId = formData.get('vehicleId');
  const password = formData.get('password');
  const confirmPassword = formData.get('confirmPassword');
  const termsAccepted = formData.get('termsAccepted');
  const document = formData.get('document');
  
  const errorMsg = document.getElementById('regErrorMessage');
  const successMsg = document.getElementById('regSuccessMessage');
  const registerBtn = document.getElementById('registerBtn');
  
  try {
    errorMsg.classList.add('hidden');
    successMsg.classList.add('hidden');
    registerBtn.disabled = true;
    registerBtn.textContent = 'Registering...';
    
    // Client-side validation
    if (password !== confirmPassword) {
      throw new Error('Passwords do not match');
    }
    
    if (!termsAccepted) {
      throw new Error('You must accept Terms & Conditions');
    }
    
    const strength = validatePasswordStrength(password);
    if (!strength.isStrong) {
      throw new Error('Password is not strong enough');
    }
    
    if (document && document.size > 5 * 1024 * 1024) {
      throw new Error('Document size must be less than 5MB');
    }
    
    // Send registration request
    const registrationData = {
      fullName,
      email,
      phone,
      licenseNumber,
      licenseExpiry,
      vehicleId,
      password,
      confirmPassword,
      termsAccepted: termsAccepted === 'on'
    };
    
    const res = await fetch(`${API_BASE}/tracker/registerDriver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData)
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Registration failed');
    }
    
    // Show success message
    successMsg.textContent = 'Registration successful! Please wait for admin approval. Redirecting to login...';
    successMsg.classList.remove('hidden');
    
    // Redirect to login after 3 seconds
    setTimeout(() => {
      renderLogin();
    }, 3000);
    
  } catch (err) {
    errorMsg.textContent = err.message;
    errorMsg.classList.remove('hidden');
  } finally {
    registerBtn.disabled = false;
    registerBtn.textContent = 'Register';
  }
}

// 3. Dashboard and Trip Flow
function renderDashboard(driver) {
  const isTripActive = !!activeTripId;
  
  appDiv.innerHTML = `
    <div class="flex-1 flex flex-col p-6 bg-gray-50 h-full">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-xl font-bold text-gray-900">Hello, ${driver.name.split(' ')[0]}</h2>
        <button id="logoutBtn" class="text-sm font-semibold text-gray-500 hover:text-gray-700">Log out</button>
      </div>

      <div class="flex-1 flex flex-col justify-center items-center">
        <div id="statusIndicator" class="w-32 h-32 rounded-full flex items-center justify-center mb-8 shadow-lg transition-colors ${isTripActive ? 'bg-green-500' : 'bg-gray-300'}">
          <svg class="w-12 h-12 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="${isTripActive ? 'M5 13l4 4L19 7' : 'M12 19l9 2-9-18-9 18 9-2zm0 0v-8'}"></path>
          </svg>
        </div>
        
        <h3 class="text-2xl font-bold text-gray-900 mb-2" id="statusText">
          ${isTripActive ? 'Trip Active' : 'Ready to Drive?'}
        </h3>
        <p class="text-center text-gray-500 mb-8 px-4" id="subStatusText">
          ${isTripActive ? 'We are securely transmitting your location.' : 'Start a trip to begin broadcasting your location to the Fleet Admin.'}
        </p>

        <button id="tripBtn" class="w-full max-w-xs rounded-lg py-4 text-lg font-bold text-white shadow-md transition-colors ${isTripActive ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'}">
          ${isTripActive ? 'Stop Trip' : 'Start Trip'}
        </button>
      </div>
      
      <!-- GPS Status bar -->
      <div class="mt-auto pt-6 border-t border-gray-200">
        <div class="flex justify-between text-xs text-gray-500 font-medium">
          <span>GPS Status</span>
          <span id="gpsStatus" class="${isTripActive ? 'text-green-600' : 'text-gray-400'}">${isTripActive ? 'Active' : 'Inactive'}</span>
        </div>
        <div class="flex justify-between text-xs text-gray-500 font-medium mt-1">
          <span>Last Sync</span>
          <span id="syncStatus">--</span>
        </div>
      </div>
    </div>
  `;
  
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (activeTripId) await stopTrip();
    await Preferences.remove({ key: 'driver_token' });
    await Preferences.remove({ key: 'csrf_token' });
    renderLogin();
  });

  document.getElementById('tripBtn').addEventListener('click', async () => {
    if (activeTripId) {
      await stopTrip();
      renderDashboard(driver);
    } else {
      await startTrip();
      renderDashboard(driver);
    }
  });
}

// 4. Start Trip Logic
async function startTrip() {
  try {
    const res = await authFetch('/drivers/startTrip', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    activeTripId = data.ID || data.id;
    await startTracking();
  } catch (e) {
    alert("Failed to start trip: " + e.message);
  }
}

// 5. Stop Trip Logic
async function stopTrip() {
  try {
    if (watchId != null) {
      await Geolocation.clearWatch({ id: watchId });
      watchId = null;
    }
    
    await authFetch('/drivers/stopTrip', {
      method: 'POST',
      body: JSON.stringify({ tripId: activeTripId })
    });
    
    activeTripId = null;
  } catch (e) {
    alert("Failed to stop trip: " + e.message);
  }
}

// 6. Geolocation Tracking
async function startTracking() {
  // Request permissions first
  const permissions = await Geolocation.requestPermissions();
  if (permissions.location !== 'granted') {
    alert("Location permission denied. Cannot track trip.");
    return;
  }

  // Watch position
  watchId = await Geolocation.watchPosition({
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
  }, async (position, err) => {
    if (err) {
      console.error("GPS Error:", err);
      return;
    }
    
    if (position && activeTripId) {
      // Send location to backend
      try {
        await authFetch('/drivers/recordLocation', {
          method: 'POST',
          body: JSON.stringify({
            tripId: activeTripId,
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            speed: position.coords.speed,
            heading: position.coords.heading,
            recordedAt: new Date(position.timestamp).toISOString(),
            source: 'capacitor-geolocation'
          })
        });
        
        // Update UI
        const syncSpan = document.getElementById('syncStatus');
        if (syncSpan) {
          const now = new Date();
          syncSpan.textContent = now.toLocaleTimeString();
          syncSpan.classList.add('text-green-600');
          setTimeout(() => syncSpan.classList.remove('text-green-600'), 1000);
        }
      } catch (postErr) {
        console.error("Failed to sync point", postErr);
        // Note: For full production, failed points would be pushed to 
        // local storage here and retried later.
        const syncSpan = document.getElementById('syncStatus');
        if (syncSpan) syncSpan.textContent = "Sync Failed (Offline)";
      }
    }
  });
}

// Start app
checkLogin();
