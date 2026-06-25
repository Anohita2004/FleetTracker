/**
 * Admin Dashboard Module
 * Handles admin functions like viewing and managing pending driver registrations
 */

// Fetch pending driver registrations
export async function fetchPendingRegistrations(token) {
  try {
    const res = await fetch('/tracker/getPendingRegistrations', {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!res.ok) {
      throw new Error(`Failed to fetch registrations: ${res.statusText}`);
    }
    
    return await res.json();
  } catch (error) {
    console.error('Error fetching pending registrations:', error);
    return [];
  }
}

// Approve driver registration
export async function approveDriverRegistration(driverId, token) {
  try {
    const res = await fetch('/tracker/approveDriverRegistration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ driverId })
    });
    
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Failed to approve registration');
    }
    
    return {
      success: true,
      data: await res.json()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Reject driver registration
export async function rejectDriverRegistration(driverId, reason, token) {
  try {
    const res = await fetch('/tracker/rejectDriverRegistration', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ driverId, reason })
    });
    
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Failed to reject registration');
    }
    
    return {
      success: true,
      message: await res.text()
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Format date
export function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Render admin pending registrations table
export function renderPendingRegistrationsTable(registrations) {
  if (!registrations || registrations.length === 0) {
    return `
      <div class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>
        </svg>
        <h3 class="mt-2 text-sm font-medium text-gray-900">No pending registrations</h3>
        <p class="mt-1 text-sm text-gray-500">All driver registrations have been processed.</p>
      </div>
    `;
  }
  
  const rows = registrations.map((reg, index) => `
    <tr class="border-t border-gray-200 hover:bg-gray-50">
      <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${index + 1}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-900">${escapeHtml(reg.fullName)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(reg.email)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(reg.phone)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${escapeHtml(reg.licenseNumber)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-500">${formatDate(reg.createdAt)}</td>
      <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
        <button class="approve-btn text-green-600 hover:text-green-800 mr-4" data-driver-id="${reg.ID}">Approve</button>
        <button class="reject-btn text-red-600 hover:text-red-800" data-driver-id="${reg.ID}">Reject</button>
      </td>
    </tr>
  `).join('');
  
  return `
    <div class="overflow-x-auto">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">#</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Phone</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">License</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Submitted</th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          ${rows}
        </tbody>
      </table>
    </div>
  `;
}

// Render registration detail modal
export function renderRegistrationDetailModal(registration) {
  return `
    <div class="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-96 overflow-y-auto">
        <div class="p-6">
          <div class="flex justify-between items-center mb-4">
            <h3 class="text-lg font-medium text-gray-900">Registration Details</h3>
            <button id="closeModal" class="text-gray-400 hover:text-gray-600">
              <svg class="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          
          <div class="grid grid-cols-2 gap-4">
            <div>
              <p class="text-sm text-gray-500">Full Name</p>
              <p class="text-base font-medium text-gray-900">${escapeHtml(registration.fullName)}</p>
            </div>
            <div>
              <p class="text-sm text-gray-500">Email</p>
              <p class="text-base font-medium text-gray-900">${escapeHtml(registration.email)}</p>
            </div>
            <div>
              <p class="text-sm text-gray-500">Phone</p>
              <p class="text-base font-medium text-gray-900">${escapeHtml(registration.phone)}</p>
            </div>
            <div>
              <p class="text-sm text-gray-500">License Number</p>
              <p class="text-base font-medium text-gray-900">${escapeHtml(registration.licenseNumber)}</p>
            </div>
            <div>
              <p class="text-sm text-gray-500">License Expiry</p>
              <p class="text-base font-medium text-gray-900">${formatDate(registration.licenseExpiry)}</p>
            </div>
            <div>
              <p class="text-sm text-gray-500">Vehicle ID</p>
              <p class="text-base font-medium text-gray-900">${escapeHtml(registration.vehicleId)}</p>
            </div>
            <div class="col-span-2">
              <p class="text-sm text-gray-500">Document</p>
              ${registration.documentUrl ? `
                <a href="${escapeHtml(registration.documentUrl)}" target="_blank" class="text-blue-600 hover:text-blue-800 text-base font-medium">
                  View Document ↗
                </a>
              ` : '<p class="text-base font-medium text-gray-500">No document uploaded</p>'}
            </div>
            <div class="col-span-2">
              <p class="text-sm text-gray-500">Submitted</p>
              <p class="text-base font-medium text-gray-900">${formatDate(registration.createdAt)}</p>
            </div>
          </div>
          
          <div class="mt-6 flex justify-end space-x-3">
            <button id="rejectDetailBtn" class="px-4 py-2 text-sm font-medium text-red-700 bg-red-50 hover:bg-red-100 rounded-md">Reject</button>
            <button id="approveDetailBtn" class="px-4 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-700 rounded-md">Approve</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Render rejection reason modal
export function renderRejectReasonModal(driverId) {
  return `
    <div class="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full">
        <div class="p-6">
          <h3 class="text-lg font-medium text-gray-900 mb-4">Reject Registration</h3>
          
          <div>
            <label for="rejectionReason" class="block text-sm font-medium text-gray-900 mb-2">Reason for Rejection *</label>
            <textarea id="rejectionReason" class="w-full rounded-md border-0 py-2 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-blue-600 px-3" rows="4" placeholder="Explain why the registration is being rejected..." required></textarea>
          </div>
          
          <div class="mt-6 flex justify-end space-x-3">
            <button id="cancelRejectBtn" class="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md">Cancel</button>
            <button id="confirmRejectBtn" class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md" data-driver-id="${driverId}">Reject</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
