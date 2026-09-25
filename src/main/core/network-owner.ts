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
  return (
    device.length > 0 && !virtualDevicePrefixes.some((prefix) => device.startsWith(prefix))
  )
}

export function parseNetworkServiceOrder(output: string): NetworkService[] {
  return output
    .split(/\n\s*\n/)
    .flatMap((block) => {
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

export function resolvePhysicalNetworkOwner(
  snapshot: PhysicalNetworkSnapshot,
  previous?: PhysicalNetworkOwner
): PhysicalNetworkOwner | undefined {
  const services = snapshot.services.filter(
    (service) => !service.disabled && isPhysicalDevice(service.device)
  )
  if (snapshot.defaultDevice && isPhysicalDevice(snapshot.defaultDevice)) {
    const defaultService = services.find((service) => service.device === snapshot.defaultDevice)
    return defaultService
      ? { device: defaultService.device, service: defaultService.name }
      : undefined
  }

  const activeDevices = new Set(snapshot.activeDevices)
  if (previous && activeDevices.has(previous.device)) {
    const previousService = services.find((service) => service.device === previous.device)
    if (previousService) {
      return { device: previousService.device, service: previousService.name }
    }
  }

  const activeServices = services.filter((service) => activeDevices.has(service.device))
  if (activeServices.length !== 1) return undefined
  const [service] = activeServices
  return { device: service.device, service: service.name }
}
