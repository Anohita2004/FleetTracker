/**
 * Driver Registration Module
 * Handles all registration-related functionality
 */

import { API_BASE } from './config.js';

// Validate email format
export function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Validate password strength
export function validatePasswordStrength(password) {
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

// Validate form data
export function validateRegistrationForm(data) {
  const errors = [];
  
  if (!data.fullName || data.fullName.trim().length < 2) {
    errors.push('Full name must be at least 2 characters');
  }
  
  if (!isValidEmail(data.email)) {
    errors.push('Invalid email format');
  }
  
  if (!data.phone || data.phone.trim().length < 10) {
    errors.push('Phone number must be at least 10 characters');
  }
  
  if (!data.licenseNumber || data.licenseNumber.trim().length < 3) {
    errors.push('License number is invalid');
  }
  
  if (!data.licenseExpiry) {
    errors.push('License expiry date is required');
  } else {
    const expiryDate = new Date(data.licenseExpiry);
    const today = new Date();
    if (expiryDate <= today) {
      errors.push('License must not be expired');
    }
  }
  
  if (!data.vehicleId || data.vehicleId.trim().length < 2) {
    errors.push('Vehicle ID is invalid');
  }
  
  if (data.password !== data.confirmPassword) {
    errors.push('Passwords do not match');
  }
  
  const passwordStrength = validatePasswordStrength(data.password);
  if (!passwordStrength.isStrong) {
    errors.push('Password is not strong enough');
  }
  
  if (!data.termsAccepted) {
    errors.push('You must accept Terms & Conditions');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// Register driver
export async function registerDriver(registrationData) {
  try {
    const res = await fetch(`${API_BASE}/tracker/registerDriver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(registrationData)
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || data.message || 'Registration failed');
    }
    
    return {
      success: true,
      data: data
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Validate file upload
export function validateFileUpload(file) {
  const errors = [];
  const maxSize = 5 * 1024 * 1024; // 5MB
  const allowedTypes = ['application/pdf', 'image/jpeg', 'image/png'];
  
  if (!file) {
    errors.push('Document file is required');
  } else {
    if (file.size > maxSize) {
      errors.push(`File size must be less than 5MB (current: ${(file.size / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    if (!allowedTypes.includes(file.type)) {
      errors.push('Only PDF, JPG, and PNG files are allowed');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

// Get password strength label
export function getPasswordStrengthLabel(score) {
  const labels = ['', 'Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return labels[score] || 'Very Weak';
}

// Get password strength color
export function getPasswordStrengthColor(score) {
  const colors = ['', 'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];
  return colors[score] || 'bg-red-500';
}
