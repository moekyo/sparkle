export interface NetworkService {
  name: string
  device: string
  disabled: boolean
}

export interface PhysicalNetworkOwner {
  device: string
  service: string
}

export interface PhysicalNetworkSnapshot {
  defaultDevice?: string
  primaryDevice?: string
  primaryService?: string
  activeDevices: string[]
  services: NetworkService[]
}

const virtualDevicePrefixes = [
  'utun',
  'bridge',
  'awdl',
  'llw',
  'anpi',
  'gif',
  'stf',
  'lo',
  'ap',
  'p2p',
  'vmnet',
  'vmenet',
  'tap',
  'tun',
  'wg'
]

function isPhysicalDevice(device: string): boolean {
  return device.length > 0 && !virtualDevicePrefixes.some((prefix) => device.startsWith(prefix))
}

export function parseNetworkServiceOrder(output: string): NetworkService[] {
  return output.split(/\n\s*\n/).flatMap((block) => {
    const serviceMatch = block.match(/^\((\*|\d+)\)\s+(.+)$/m)
    const deviceMatch = block.match(/Device:\s*([^,)]+)/)
    if (!serviceMatch || !deviceMatch) return []
    return [
      {
        name: serviceMatch[2].trim(),
        device: deviceMatch[1].trim(),
        disabled: serviceMatch[1] === '*'
      }
    ]
  })
}

export function parsePrimaryPhysicalService(
  globalIPv4State: string,
  setupInterface: string
): PhysicalNetworkOwner | undefined {
  const primaryDevice = globalIPv4State.match(/^\s*PrimaryInterface\s*:\s*(\S+)\s*$/m)?.[1]
  const primaryService = setupInterface.match(/^\s*UserDefinedName\s*:\s*(.+?)\s*$/m)?.[1]
  const configuredDevice = setupInterface.match(/^\s*DeviceName\s*:\s*(\S+)\s*$/m)?.[1]
  if (
    !primaryDevice ||
    !primaryService ||
    configuredDevice !== primaryDevice ||
    !isPhysicalDevice(primaryDevice)
  ) {
    return undefined
  }
  return { device: primaryDevice, service: primaryService }
}

export function resolvePhysicalNetworkOwner(
  snapshot: PhysicalNetworkSnapshot,
  previous?: PhysicalNetworkOwner
): PhysicalNetworkOwner | undefined {
  void previous
  const services = snapshot.services.filter(
    (service) => !service.disabled && isPhysicalDevice(service.device)
  )
  if (snapshot.defaultDevice && isPhysicalDevice(snapshot.defaultDevice)) {
    const defaultService = services.find((service) => service.device === snapshot.defaultDevice)
    return defaultService
      ? { device: defaultService.device, service: defaultService.name }
      : undefined
  }

  if (
    snapshot.primaryDevice &&
    snapshot.primaryService &&
    isPhysicalDevice(snapshot.primaryDevice)
  ) {
    const primaryService = services.find(
      (service) =>
        service.device === snapshot.primaryDevice && service.name === snapshot.primaryService
    )
    if (primaryService) {
      return { device: primaryService.device, service: primaryService.name }
    }
  }

  const activeDevices = new Set(snapshot.activeDevices)
  const activeServices = services.filter((service) => activeDevices.has(service.device))
  if (activeServices.length !== 1) return undefined
  const [service] = activeServices
  return { device: service.device, service: service.name }
}
