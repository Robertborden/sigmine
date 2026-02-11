// Dynamic Navigation based on auth state
function renderNavigation(activePage = 'home') {
  const apiKey = localStorage.getItem('sigmine_api_key');
  const userType = localStorage.getItem('sigmine_user_type');
  const isLoggedIn = !!(apiKey || userType);
  
  // Base navigation (always visible)
  let navLinks = `
    <a href="/" class="nav-link ${activePage === 'home' ? 'active' : ''} flex items-center gap-1">
      <i data-lucide="home" class="w-4 h-4"></i> Home
    </a>
    <a href="/how.html" class="nav-link ${activePage === 'how' ? 'active' : ''} flex items-center gap-1">
      <i data-lucide="book-open" class="w-4 h-4"></i> How It Works
    </a>
  `;
  
  // Add logged-in navigation
  if (isLoggedIn) {
    navLinks += `
      <a href="/dashboard.html" class="nav-link ${activePage === 'dashboard' ? 'active' : ''} flex items-center gap-1">
        <i data-lucide="layout-dashboard" class="w-4 h-4"></i> Dashboard
      </a>
      <a href="/leaderboard.html" class="nav-link ${activePage === 'leaderboard' ? 'active' : ''} flex items-center gap-1">
        <i data-lucide="trophy" class="w-4 h-4"></i> Leaderboard
      </a>
      <a href="/signals.html" class="nav-link ${activePage === 'signals' ? 'active' : ''} flex items-center gap-1">
        <i data-lucide="radio" class="w-4 h-4"></i> Signals
      </a>
    `;
    
    // Tasks page only for agents
    if (userType === 'agent') {
      navLinks += `
        <a href="/tasks.html" class="nav-link ${activePage === 'tasks' ? 'active' : ''} flex items-center gap-1">
          <i data-lucide="pickaxe" class="w-4 h-4"></i> Mining
        </a>
      `;
    }
    
    navLinks += `
      <a href="/profile.html" class="nav-link ${activePage === 'profile' ? 'active' : ''} flex items-center gap-1">
        <i data-lucide="user" class="w-4 h-4"></i> Profile
      </a>
    `;
  }
  
  return navLinks;
}

// Initialize navigation on page load
document.addEventListener('DOMContentLoaded', () => {
  const navContainer = document.getElementById('nav-links');
  if (navContainer) {
    const currentPage = document.body.dataset.page || 'home';
    navContainer.innerHTML = renderNavigation(currentPage);
    if (window.lucide) lucide.createIcons();
  }
});
