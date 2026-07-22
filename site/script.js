(() => {
  'use strict';

  const html = document.documentElement;
  const langBtns = document.querySelectorAll('.lang-btn');
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');
  let currentLang = 'ru';

  function setLang(lang) {
    currentLang = lang;
    html.setAttribute('data-lang', lang);
    html.setAttribute('lang', lang === 'ru' ? 'ru' : 'en');
    langBtns.forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
    });
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
    try {
      localStorage.setItem('whispernet-lang', lang);
    } catch (_) { /* ignore quota or private mode */ }
  }

  langBtns.forEach(btn => {
    btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang')));
  });

  try {
    const saved = localStorage.getItem('whispernet-lang');
    if (saved) setLang(saved);
  } catch (_) { /* ignore quota or private mode */ }

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const open = navLinks.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    navLinks.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        navLinks.classList.remove('open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const nav = document.querySelector('.nav');
  const onScroll = () => {
    nav.classList.toggle('scrolled', window.scrollY > 40);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.feature-card, .security-card, .download-card, .doc-card, .faq-item, .hero-stats').forEach(el => {
    if (prefersReducedMotion) {
      el.classList.add('visible');
    } else {
      el.classList.add('animate-in');
      observer.observe(el);
    }
  });

  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id === '#') return;
      const target = document.querySelector(id);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
  });
})();
