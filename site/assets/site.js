const copyButton = document.querySelector('#copy-source');
const source = document.querySelector('#source-url');
const status = document.querySelector('#copy-status');

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    status.textContent = 'Source URL copied.';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'URL selected. Copy it with your browser or keyboard.';
  }
});

if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  document.documentElement.classList.add('motion');
  const sections = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.removeAttribute('data-awaiting');
        observer.unobserve(entry.target);
      }
    }
  }, { threshold: 0.06 });
  for (const section of sections) {
    section.setAttribute('data-awaiting', '');
    observer.observe(section);
  }
}
