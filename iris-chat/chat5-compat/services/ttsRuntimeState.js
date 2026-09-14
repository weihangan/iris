const fs = require('fs');
const path = require('path');

function normalizeDevice(value) {
  const device = String(value || '').toLowerCase();
  if (device === 'cpu') return 'cpu';
  if (device === 'gpu' || device === 'cuda') return 'gpu';
  return null;
}

function matchesOwnedService(ownership, status) {
  if (!ownership || !status) return false;
  const pid = Number(status.pid);
  return ownership.schemaVersion === 1
    && typeof ownership.instanceId === 'string'
    && ownership.instanceId.length >= 8
    && status.instance_id === ownership.instanceId
    && Number.isInteger(pid)
    && pid > 0
    && pid === Number(ownership.pid)
    && status.flavor === ownership.flavor
    && normalizeDevice(status.expected_device) === normalizeDevice(ownership.expectedDevice);
}

function classifyTtsService({ status, expectedDevice, flavor, ownership }) {
  if (!status) {
    return {
      serviceReachable: false,
      ready: false,
      actualDevice: null,
      deviceMismatch: false,
      flavorMismatch: false,
      ttsAvailable: false,
      owned: false,
      reusable: false,
    };
  }
  const actualDevice = normalizeDevice(status.device || status.expected_device);
  const desiredDevice = normalizeDevice(expectedDevice);
  const ready = status.ready === true || status.status === 'ready';
  const deviceMismatch = Boolean(actualDevice && desiredDevice && actualDevice !== desiredDevice);
  const flavorMismatch = Boolean(status.flavor && flavor && status.flavor !== flavor);
  const owned = matchesOwnedService(ownership, status);
  return {
    serviceReachable: true,
    ready,
    actualDevice,
    deviceMismatch,
    flavorMismatch,
    ttsAvailable: ready && !deviceMismatch && !flavorMismatch,
    owned,
    reusable: ready && !deviceMismatch && !flavorMismatch && owned,
  };
}

function readOwnershipRecord(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && value.schemaVersion === 1 ? value : null;
  } catch {
    return null;
  }
}

function writeOwnershipRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

function clearOwnershipRecord(filePath, expectedInstanceId = null) {
  const current = readOwnershipRecord(filePath);
  if (expectedInstanceId && current?.instanceId !== expectedInstanceId) return false;
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  classifyTtsService,
  matchesOwnedService,
  readOwnershipRecord,
  writeOwnershipRecord,
  clearOwnershipRecord,
};
