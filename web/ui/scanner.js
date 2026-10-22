// The card scanner. Until the camera is wired, it only offers typing the number.
export function openScanner(box) {
  box.textContent = "La cámara llegará pronto: escribe el número.";
  return () => {};
}
