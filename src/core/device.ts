/**
 * Device info helpers
 */

export interface DeviceProperties {
  $user_agent?: string;
  $timezone?: string;
  $screen_width?: number;
  $screen_height?: number;
  $viewport_width?: number;
  $viewport_height?: number;
  $language?: string;
  $languages?: string[];
  $platform?: string;
  $browser?: string;
}

const detectBrowserName = (userAgent: string): string => {
  if (userAgent.includes('Edg/')) return 'Edge';
  if (userAgent.includes('OPR/')) return 'Opera';
  if (userAgent.includes('Chrome/')) return 'Chrome';
  if (userAgent.includes('Safari/') && !userAgent.includes('Chrome/')) return 'Safari';
  if (userAgent.includes('Firefox/')) return 'Firefox';
  if (userAgent.includes('MSIE') || userAgent.includes('Trident/')) return 'IE';
  return 'Unknown';
};

export const getDeviceProperties = (): DeviceProperties => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {};
  }

  const userAgent = navigator.userAgent || '';
  const language = navigator.language || '';
  const languages = Array.isArray(navigator.languages) ? navigator.languages : undefined;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    $user_agent: userAgent,
    $timezone: timezone,
    $screen_width: window.screen?.width,
    $screen_height: window.screen?.height,
    $viewport_width: window.innerWidth,
    $viewport_height: window.innerHeight,
    $language: language,
    $languages: languages,
    $platform: navigator.platform,
    $browser: detectBrowserName(userAgent),
  };
};
