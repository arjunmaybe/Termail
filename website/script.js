// Copy buttons for the setup command blocks. Progressive enhancement:
// without JavaScript the commands remain fully readable and selectable.
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy') ?? '';
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select manually';
    }
    window.setTimeout(() => {
      button.textContent = label;
    }, 1600);
  });
});
