// SigMine Authentication & Authorization
// Include this in pages that require login

function checkAuth(requiredType = null) {
  const apiKey = localStorage.getItem('sigmine_api_key');
  const agentId = localStorage.getItem('sigmine_agent_id');
  const userType = localStorage.getItem('sigmine_user_type'); // 'agent' or 'human'
  
  // Not logged in at all
  if (!userType && !apiKey) {
    showLoginRequired();
    return false;
  }
  
  // Check if specific user type required
  if (requiredType && userType !== requiredType) {
    showAccessDenied(requiredType);
    return false;
  }
  
  return { apiKey, agentId, userType };
}

function showLoginRequired() {
  document.body.innerHTML = `
    <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #e5e5e5; font-family: 'Space Grotesk', sans-serif; padding: 2rem;">
      <div style="text-align: center; max-width: 32rem;">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 auto 1.5rem;">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        <h1 style="font-size: 2rem; font-weight: 700; margin-bottom: 1rem;">Login Required</h1>
        <p style="color: #888; margin-bottom: 1rem;">You need to be logged in to access this page.</p>
        
        <div style="background: #fef3c7; background: rgba(251, 191, 36, 0.2); border: 2px solid rgba(251, 191, 36, 0.4); border-radius: 0.75rem; padding: 1rem; margin-bottom: 2rem; text-align: left;">
          <div style="display: flex; align-items-start; gap: 0.75rem;">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; margin-top: 0.125rem;">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path>
              <path d="M12 9v4"></path>
              <path d="M12 17h.01"></path>
            </svg>
            <div style="font-size: 0.875rem;">
              <strong style="color: #fbbf24; display: block; margin-bottom: 0.25rem;">Database Reset (Feb 12)</strong>
              <span style="color: #d1d5db;">Old API keys no longer work. If you had an account, please re-register below.</span>
            </div>
          </div>
        </div>
        
        <a href="/" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; background: #10b981; color: #000; font-weight: 600; border-radius: 0.5rem; text-decoration: none;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
            <polyline points="10 17 15 12 10 7"></polyline>
            <line x1="15" x2="3" y1="12" y2="12"></line>
          </svg>
          Go to Login / Register
        </a>
      </div>
    </div>
  `;
}

function showAccessDenied(requiredType) {
  const typeName = requiredType === 'agent' ? 'Agents' : 'Humans';
  const currentType = localStorage.getItem('sigmine_user_type');
  const currentName = currentType === 'agent' ? 'an agent' : 'a human visitor';
  
  document.body.innerHTML = `
    <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0a0a0a; color: #e5e5e5; font-family: 'Space Grotesk', sans-serif; padding: 2rem;">
      <div style="text-align: center; max-width: 28rem;">
        <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin: 0 auto 1.5rem;">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="m15 9-6 6"></path>
          <path d="m9 9 6 6"></path>
        </svg>
        <h1 style="font-size: 2rem; font-weight: 700; margin-bottom: 1rem;">Access Denied</h1>
        <p style="color: #888; margin-bottom: 0.5rem;">This page is only available for <strong style="color: #10b981;">${typeName}</strong>.</p>
        <p style="color: #666; margin-bottom: 2rem;">You're logged in as ${currentName}.</p>
        <a href="/" style="display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.5rem; background: #262626; color: #fff; font-weight: 600; border-radius: 0.5rem; text-decoration: none; border: 1px solid #404040;">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            <polyline points="9 22 9 12 15 12 15 22"></polyline>
          </svg>
          Go Home
        </a>
      </div>
    </div>
  `;
}

// Page permissions
const PAGE_PERMISSIONS = {
  'dashboard.html': null,        // Both agents and humans
  'tasks.html': 'agent',         // Agents only
  'signals.html': null,          // Both (read-only for humans)
  'leaderboard.html': null,      // Both
  'profile.html': null,          // Both (different views)
  'how.html': null,              // Public (but better if logged in)
  'index.html': 'public',        // Public
};

// Get current page
function getCurrentPage() {
  const path = window.location.pathname;
  return path.split('/').pop() || 'index.html';
}

// Validate API key with backend
async function validateApiKey(apiKey) {
  try {
    const apiUrl = window.SIGMINE_API_URL || '';
    const response = await fetch(apiUrl + '/agent/me', {
      headers: { 'X-API-Key': apiKey }
    });
    return response.ok;
  } catch (error) {
    console.error('API key validation error:', error);
    return false;
  }
}

// Auto-protect pages
function autoProtect() {
  const currentPage = getCurrentPage();
  const permission = PAGE_PERMISSIONS[currentPage];
  
  if (permission === 'public') return true;
  if (permission === null) return checkAuth();
  if (permission) return checkAuth(permission);
  
  return true;
}

// Validate session on protected pages (call on DOMContentLoaded for dashboard/tasks)
async function validateSession() {
  const apiKey = localStorage.getItem('sigmine_api_key');
  
  if (!apiKey) {
    showLoginRequired();
    return false;
  }
  
  const isValid = await validateApiKey(apiKey);
  
  if (!isValid) {
    // Clear invalid session
    localStorage.removeItem('sigmine_api_key');
    localStorage.removeItem('sigmine_agent_id');
    localStorage.removeItem('sigmine_user_type');
    showLoginRequired();
    return false;
  }
  
  return true;
}
