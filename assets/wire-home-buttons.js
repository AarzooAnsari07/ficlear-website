(function(){
  function run() {
    function goto(url) { window.location.href = url; }

    // Hero & Offers: simple text-match
    var heroBtn = Array.from(document.querySelectorAll('button, a')).find(function (el) {
      return el.textContent && el.textContent.trim().startsWith('Check Eligibility Now');
    });
    if (heroBtn && !heroBtn.closest('a')) heroBtn.addEventListener('click', function () { goto('LoanEligibility.html'); });

    var offersBtn = Array.from(document.querySelectorAll('button, a')).find(function (el) {
      return el.textContent && el.textContent.trim().startsWith('View All Offers');
    });
    if (offersBtn && !offersBtn.closest('a')) offersBtn.addEventListener('click', function () { goto('LiveOffers.html'); });

    // Cards: find "Open Checker" buttons and map by nearest h3 text
    var cardButtons = Array.from(document.querySelectorAll('button')).filter(function (b) {
      return b.textContent && b.textContent.trim().startsWith('Open Checker');
    });
    cardButtons.forEach(function (btn) {
      var container = btn.closest('[data-slot="card-content"], [data-slot="card"]') || btn.parentElement;
      var h3 = container && container.querySelector('h3');
      var title = h3 ? h3.textContent.trim().toLowerCase() : '';
      if (title.includes('company')) btn.addEventListener('click', function () { goto('CompanyChecker.html'); });
      else if (title.includes('pin')) btn.addEventListener('click', function () { goto('PINCodeChecker.html'); });
      else if (title.includes('eligib')) btn.addEventListener('click', function () { goto('LoanEligibility.html'); });
    });

    // Make sure buttons look clickable
    document.querySelectorAll('button[data-slot="button"]').forEach(function(b){ b.style.cursor = 'pointer'; });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    // If the script is injected after DOMContentLoaded, run immediately
    run();
  }
})();
