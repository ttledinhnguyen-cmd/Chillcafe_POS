// ===== NAVBAR SCROLL =====
const navbar = document.getElementById('navbar');

window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }
});

// ===== MOBILE NAV TOGGLE =====
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
    navLinks.classList.toggle('active');
    navToggle.classList.toggle('active');
});

// Close mobile nav on link click
document.querySelectorAll('.nav-links a').forEach(link => {
    link.addEventListener('click', () => {
        navLinks.classList.remove('active');
        navToggle.classList.remove('active');
    });
});

// ===== ACTIVE NAV LINK ON SCROLL =====
const sections = document.querySelectorAll('section[id]');

window.addEventListener('scroll', () => {
    const scrollY = window.scrollY + 100;

    sections.forEach(section => {
        const sectionTop = section.offsetTop;
        const sectionHeight = section.offsetHeight;
        const sectionId = section.getAttribute('id');
        const navLink = document.querySelector(`.nav-links a[href="#${sectionId}"]`);

        if (navLink && scrollY >= sectionTop && scrollY < sectionTop + sectionHeight) {
            document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
            navLink.classList.add('active');
        }
    });
});

// ===== MENU TABS =====
const menuTabs = document.querySelectorAll('.menu-tab');
const menuItems = document.querySelectorAll('.menu-item');

menuTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        const category = tab.dataset.category;

        menuTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        menuItems.forEach(item => {
            if (item.dataset.category === category) {
                item.style.display = 'flex';
                item.style.animation = 'fadeInUp 0.5s ease';
            } else {
                item.style.display = 'none';
            }
        });
    });
});

// Initialize: show only coffee items
document.addEventListener('DOMContentLoaded', () => {
    menuItems.forEach(item => {
        if (item.dataset.category !== 'coffee') {
            item.style.display = 'none';
        }
    });
});

// ===== STATS COUNTER =====
const statNumbers = document.querySelectorAll('.stat-number');
let statsAnimated = false;

function animateStats() {
    statNumbers.forEach(stat => {
        const target = parseFloat(stat.dataset.target);
        const isDecimal = target % 1 !== 0;
        const duration = 2000;
        const step = target / (duration / 16);
        let current = 0;

        const counter = setInterval(() => {
            current += step;
            if (current >= target) {
                stat.textContent = isDecimal ? target.toFixed(1) : target;
                clearInterval(counter);
            } else {
                stat.textContent = isDecimal ? current.toFixed(1) : Math.floor(current);
            }
        }, 16);
    });
}

// Intersection Observer for stats
const statsSection = document.querySelector('.stats');
if (statsSection) {
    const statsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && !statsAnimated) {
                statsAnimated = true;
                animateStats();
            }
        });
    }, { threshold: 0.5 });

    statsObserver.observe(statsSection);
}

// ===== SCROLL ANIMATIONS =====
const fadeElements = document.querySelectorAll('.about-grid, .menu-item, .gallery-item, .testimonial-card, .contact-card, .contact-form-wrapper');

fadeElements.forEach(el => el.classList.add('fade-in'));

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
        }
    });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

fadeElements.forEach(el => fadeObserver.observe(el));

// ===== BACK TO TOP =====
const backToTop = document.getElementById('backToTop');

window.addEventListener('scroll', () => {
    if (window.scrollY > 500) {
        backToTop.classList.add('visible');
    } else {
        backToTop.classList.remove('visible');
    }
});

backToTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ===== CONTACT FORM =====
const contactForm = document.getElementById('contactForm');

if (contactForm) {
    contactForm.addEventListener('submit', (e) => {
        e.preventDefault();

        const btn = contactForm.querySelector('.btn');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> Đã gửi thành công!';
        btn.style.background = '#27ae60';

        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.style.background = '';
            contactForm.reset();
        }, 3000);
    });
}

// ===== SMOOTH SCROLL FOR ANCHOR LINKS =====
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            const offsetTop = target.offsetTop - 70;
            window.scrollTo({ top: offsetTop, behavior: 'smooth' });
        }
    });
});
