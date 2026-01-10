(function(){
  // Bind to the contact form by locating the `#message` textarea, then finding its form.
  var textarea = document.querySelector('#message');
  if(!textarea) return;
  var form = textarea.closest('form');
  if(!form) return;

  var submitBtn = form.querySelector('button[type="submit"]');
  var clearBtn = form.querySelector('button[type="button"]');

  function showAlert(msg){
    try { alert(msg); } catch(e){ console.log(msg); }
  }

  form.addEventListener('submit', async function(e){
    e.preventDefault();
    if(submitBtn) submitBtn.disabled = true;

    var payload = {
      name: (form.name && form.name.value) || '',
      email: (form.email && form.email.value) || '',
      phone: (form.phone && form.phone.value) || '',
      subject: (form.subject && form.subject.value) || '',
      message: (form.message && form.message.value) || ''
    };

    try {
      var res = await fetch('http://localhost:3000/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if(res.ok){
        showAlert('Message sent. We will contact you shortly.');
        form.reset();
      } else {
        var body = {};
        try { body = await res.json(); } catch(e){}
        showAlert('Failed to send message: ' + (body.error || res.statusText || res.status));
      }
    } catch(err){
      showAlert('Network error: ' + err.message);
    } finally {
      if(submitBtn) submitBtn.disabled = false;
    }
  });

  if(clearBtn){
    clearBtn.addEventListener('click', function(){ form.reset(); });
  }
})();
