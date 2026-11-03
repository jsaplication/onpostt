'use strict';

(function () {
  var links = Array.prototype.slice.call(document.querySelectorAll('.doc-side a'));
  var sections = links
    .map(function (link) {
      var id = link.getAttribute('href');
      return id && id.charAt(0) === '#' ? document.querySelector(id) : null;
    })
    .filter(Boolean);

  function activate(id) {
    links.forEach(function (link) {
      var isActive = link.getAttribute('href') === '#' + id;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  if ('IntersectionObserver' in window && sections.length) {
    var visible = new Map();

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.boundingClientRect.top);
          else visible.delete(entry.target.id);
        });

        if (visible.size === 0) return;
        var current = Array.from(visible.entries()).sort(function (a, b) {
          return a[1] - b[1];
        })[0];
        if (current) activate(current[0]);
      },
      { rootMargin: '-88px 0px -55% 0px', threshold: [0, 1] }
    );

    sections.forEach(function (section) {
      observer.observe(section);
    });
  } else {
    var onScroll = function () {
      var current = sections[0];
      sections.forEach(function (section) {
        if (section.getBoundingClientRect().top <= 120) current = section;
      });
      if (current) activate(current.id);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.className = 'sr-only';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } catch (error) {
      /* ignore */
    }
    area.remove();
  }

  document.querySelectorAll('pre').forEach(function (pre) {
    var wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrap';
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-small copy-btn';
    button.textContent = 'copiar';

    button.addEventListener('click', function () {
      var text = pre.textContent || '';
      var done = function () {
        button.textContent = 'copiado';
        setTimeout(function () {
          button.textContent = 'copiar';
        }, 1800);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          fallbackCopy(text);
          done();
        });
      } else {
        fallbackCopy(text);
        done();
      }
    });

    wrapper.appendChild(button);
  });
})();
