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
      </div>
    </div>
  `;

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
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
  });
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
