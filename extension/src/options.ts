import { DAEMON_PORT } from './protocol';
import { getDaemonPort, setDaemonPort } from './daemon-config';

const form = document.querySelector<HTMLFormElement>('#daemon-form');
const input = document.querySelector<HTMLInputElement>('#daemon-port');
const status = document.querySelector<HTMLElement>('#status');

if (!form || !input || !status) throw new Error('Options page is missing required elements');

void getDaemonPort().then((port) => {
  input.value = String(port);
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const port = Number(input.value);
  void setDaemonPort(port).then(() => {
    status.textContent = `Saved. This Chrome profile will connect to daemon port ${port}.`;
  }).catch((error) => {
    status.textContent = error instanceof Error ? error.message : String(error);
  });
});

document.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
  input.value = String(DAEMON_PORT);
  form.requestSubmit();
});
