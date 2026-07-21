(() => {
  'use strict';

  const html = document.documentElement;
  const langToggle = document.getElementById('langToggle');
  let currentLang = 'ru';

  function setLang(lang) {
    currentLang = lang;
    html.setAttribute('data-lang', lang);
    html.setAttribute('lang', lang === 'ru' ? 'ru' : 'en');
    langToggle.textContent = lang === 'ru' ? 'EN' : 'RU';
    document.querySelectorAll('[data-ru][data-en]').forEach(el => {
      el.textContent = el.getAttribute(`data-${lang}`);
    });
    const title = lang === 'ru' ? 'WhisperNet — Безопасный мессенджер' : 'WhisperNet — Secure Messenger';
    document.title = title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute('content', lang === 'ru'
        ? 'Минималистичный мессенджер с сквозным шифрованием на базе Signal Protocol'
        : 'Minimalist messenger with end-to-end encryption based on Signal Protocol');
    }
    localStorage.setItem('whispernet-lang', lang);
  }

  langToggle.addEventListener('click', () => {
    setLang(currentLang === 'ru' ? 'en' : 'ru');
  });

  const saved = localStorage.getItem('whispernet-lang');
  if (saved) setLang(saved);

  // Nav scroll effect
  const nav = document.querySelector('.nav');
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Scroll reveal
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.feature-card, .security-card, .download-card, .doc-card, .faq-item, .hero-stats').forEach(el => {
    el.classList.add('animate-in');
    observer.observe(el);
  });

  // Smooth scroll for anchor links
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id === '#') return;
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });
})();
