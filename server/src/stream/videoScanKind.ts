export function videoScanKind(
  fieldOrder?: string,
): 'unknown' | 'progressive' | 'interlaced' {
  switch (fieldOrder) {
    case 'tt':
    case 'bb':
    case 'tb':
    case 'bt':
      return 'interlaced';
    case 'progressive':
      return 'progressive';
    default:
      return 'unknown';
  }
}
