
// Device ID validity and collision guard: reject empty, short (< 35 chars), un-hyphenated, or known legacy collision tokens
function isInvalidOrCollidedDeviceId(deviceId) {
  if (!deviceId || typeof deviceId !== 'string') return true;
  const clean = deviceId.trim();
  if (clean.length < 35 || !clean.includes('-')) return true;
  if (clean.startsWith('dev_NDE0eDg5') ||
      clean.startsWith('dev_NDQweDk1') ||
      clean.startsWith('dev_NDI4eDky') ||
      clean.startsWith('dev_MzYweDgw')) {
    return true;
  }
  return false;
}

export { isInvalidOrCollidedDeviceId };
