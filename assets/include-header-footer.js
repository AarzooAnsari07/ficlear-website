 (function(){
  function includeHTML(selector, url) {
    return fetch(url).then(function(resp){
      if(!resp.ok) return Promise.reject(resp);
      return resp.text();
    }).then(function(html){
      var container = document.querySelector(selector);
      if(container) container.innerHTML = html;
    }).catch(function(){
      console.warn('Could not load: ' + url);
    });
  }

  function setActiveNav(){
    var header = document.querySelector('#site-header');
    if(!header) return;
    var page = (location.pathname.split('/').pop() || 'index.html');
    var links = header.querySelectorAll('a[href]');
    links.forEach(function(a){
      var href = (a.getAttribute('href')||'').split('/').pop();
      if(href === page) {
        a.classList.add('bg-blue-50','text-blue-700');
        a.setAttribute('aria-current','page');
      } else {
        a.classList.remove('bg-blue-50','text-blue-700');
        a.removeAttribute('aria-current');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function(){
    Promise.all([
      includeHTML('#site-header', 'partials/header.html'),
      includeHTML('#site-footer', 'partials/footer.html')
    ]).then(function(){
      setActiveNav();
      
      // Initialize mobile menu after header is loaded
      initMobileMenu();
      
      // If the contact form (identified by `#message` textarea) exists on the page,
      // lazy-load the contact form handler so we don't add JS to every page.
      try {
        if (document.querySelector('#message')) {
          var s = document.createElement('script');
          s.src = '/assets/contact-form.js';
          s.defer = true;
          document.body.appendChild(s);
        }
        // Load home page wiring for CTAs when on the homepage
        var page = (location.pathname.split('/').pop() || 'index.html');
        if (page === 'index.html') {
          var h = document.createElement('script');
          h.src = '/assets/wire-home-buttons.js';
          h.defer = true;
          document.body.appendChild(h);
        }
      } catch (e) {
        console.warn('Failed to load page-specific scripts', e);
      }
    });
  });
  
  // Mobile menu toggle functionality
  function initMobileMenu() {
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    
    if (mobileMenuBtn && mobileMenu) {
      // Clone button to remove old listeners
      mobileMenuBtn.replaceWith(mobileMenuBtn.cloneNode(true));
      const newBtn = document.getElementById('mobile-menu-btn');
      
      // Toggle menu function
      function toggleMenu(shouldClose = null) {
        const menu = document.getElementById('mobile-menu');
        const isHidden = shouldClose !== null ? shouldClose : !menu.classList.contains('hidden');
        
        if (isHidden) {
          menu.classList.add('hidden');
          document.body.style.overflow = '';
        } else {
          menu.classList.remove('hidden');
          document.body.style.overflow = 'hidden';
        }
      }
      
      // Click hamburger button
      newBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        toggleMenu();
      });
      
      // Close menu when clicking a link
      const menuLinks = document.querySelectorAll('#mobile-menu a');
      menuLinks.forEach(link => {
        link.addEventListener('click', function() {
          toggleMenu(true);
        });
      });
      
      // Close menu when clicking outside
      document.addEventListener('click', function(e) {
        const menu = document.getElementById('mobile-menu');
        if (!menu.classList.contains('hidden') && 
            !menu.contains(e.target) && 
            !newBtn.contains(e.target)) {
          toggleMenu(true);
        }
      });
      
      // Close menu with ESC key
      document.addEventListener('keydown', function(e) {
        const menu = document.getElementById('mobile-menu');
        if (e.key === 'Escape' && !menu.classList.contains('hidden')) {
          toggleMenu(true);
        }
      });
    }
  }
})();