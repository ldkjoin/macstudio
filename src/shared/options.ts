import type { ProductSpec } from './types.js';

export type ChipOption = {
  chip: string;
  processors: Array<{
    label: string;
    cpu: string;
    gpu: string;
    memory: string[];
    storage: string[];
  }>;
};

export const macStudioOptions: ChipOption[] = [
  {
    chip: 'M4 Max',
    processors: [
      {
        label: '14核CPU / 32核GPU',
        cpu: '14核',
        gpu: '32核',
        memory: ['36GB'],
        storage: ['512GB', '1TB', '2TB', '4TB', '8TB']
      },
      {
        label: '16核CPU / 40核GPU',
        cpu: '16核',
        gpu: '40核',
        memory: ['36GB', '64GB', '128GB'],
        storage: ['512GB', '1TB', '2TB', '4TB', '8TB']
      }
    ]
  },
  {
    chip: 'M3 Ultra',
    processors: [
      {
        label: '28核CPU / 60核GPU',
        cpu: '28核',
        gpu: '60核',
        memory: ['96GB', '256GB', '512GB'],
        storage: ['1TB', '2TB', '4TB', '8TB', '16TB']
      },
      {
        label: '32核CPU / 80核GPU',
        cpu: '32核',
        gpu: '80核',
        memory: ['96GB', '256GB', '512GB'],
        storage: ['1TB', '2TB', '4TB', '8TB', '16TB']
      }
    ]
  }
];

export function defaultSpec(): ProductSpec {
  return {
    chip: 'M3 Ultra',
    cpu: '32核',
    gpu: '80核',
    memory: '96GB',
    storage: '16TB'
  };
}

export function specKeywords(spec: ProductSpec): string[] {
  return [spec.chip, spec.cpu, spec.gpu, spec.memory, spec.storage];
}

export function productNameFromSpec(spec: ProductSpec): string {
  return `Mac Studio ${specKeywords(spec).join(' / ')}`;
}

export function urlFromSpec(spec: ProductSpec): string {
  const chipSlug = spec.chip.toLowerCase().replace(/\s+/g, '-');
  const cpu = spec.cpu.match(/\d+/)?.[0] ?? '';
  const gpu = spec.gpu.match(/\d+/)?.[0] ?? '';
  return `https://www.apple.com.cn/shop/buy-mac/mac-studio/${chipSlug}-chip-${cpu}-core-cpu-${gpu}-core-gpu-${spec.memory.toLowerCase()}-memory-${spec.storage.toLowerCase()}-storage`;
}

export function normalizeSpecToOptions(spec: ProductSpec): ProductSpec {
  const chip = macStudioOptions.find((item) => item.chip === spec.chip) ?? macStudioOptions[1];
  const processor = chip.processors.find((item) => item.cpu === spec.cpu && item.gpu === spec.gpu) ?? chip.processors[0];
  return {
    chip: chip.chip,
    cpu: processor.cpu,
    gpu: processor.gpu,
    memory: processor.memory.includes(spec.memory) ? spec.memory : processor.memory[0],
    storage: processor.storage.includes(spec.storage) ? spec.storage : processor.storage[0]
  };
}
