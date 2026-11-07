(() => {
  'use strict';

  const html = document.documentElement;
  const langBtns = document.querySelectorAll('.lang-btn');
  const navToggle = document.querySelector('.nav-toggle');
  const navLinks = document.querySelector('.nav-links');
  const themeToggle = document.getElementById('theme-toggle');
  let currentLang = 'ru';

  function applyTheme(theme) {
    html.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  function setTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem('whispernet-theme', theme);
    } catch (_) { /* ignore quota or private mode */ }
  }

  let savedTheme = 'light';
  try {
    savedTheme = localStorage.getItem('whispernet-theme') || 'light';
  } catch (_) { /* ignore quota or private mode */ }
  applyTheme(savedTheme);

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      setTheme(next);
    });
  }

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
        ? 'Минималистичный мессенджер со сквозным шифрованием на базе Signal Protocol'
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
  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('scrolled', window.scrollY > 40);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  const sectionEls = Array.from(document.querySelectorAll('section[id]'));
  const navMap = new Map();
  document.querySelectorAll('.nav-links a[href^="#"]').forEach(a => {
    const id = a.getAttribute('href').slice(1);
    if (id) navMap.set(id, a);
  });
  if (sectionEls.length && navMap.size) {
    const onSpy = () => {
      const probe = window.scrollY + 160;
      let current = '';
      for (const s of sectionEls) {
        if (s.getBoundingClientRect().top + window.scrollY <= probe) current = s.id;
      }
      navMap.forEach((a, id) => a.classList.toggle('active', id === current));
    };
    window.addEventListener('scroll', onSpy, { passive: true });
    onSpy();
  }

  const revealTargets = document.querySelectorAll('.feature-card, .security-card, .download-card, .doc-card, .faq-item, .hero-stats');

  // Nothing here is load-bearing, so a browser without the observer should simply skip the effect rather
  // than throw out of the rest of this block. It used to be constructed unguarded, which meant the
  // remaining initialisation never ran on a browser without it.
  const Observer = window.IntersectionObserver;
  const observer = typeof Observer === 'function'
    ? new Observer((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' })
    : null;

  revealTargets.forEach(el => {
    if (prefersReducedMotion || !observer) {
      // Shown rather than left blank: an element that only becomes visible via JS is invisible to anyone
      // whose browser cannot run the observer at all.
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
