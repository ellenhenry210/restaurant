// A plain async function, not a hook — this is a one-shot request
// (called once from ScanPage's effect), not something a component needs
// to subscribe to over time.
export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Your browser does not support location access, which this site needs to confirm you\'re at the restaurant.'));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude });
      },
      (error) => {
        // error.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        const message =
          error.code === 1
            ? 'Location access was denied. Please allow location access for this site and try again — it\'s how we confirm you\'re actually at the restaurant.'
            : error.code === 3
              ? 'Getting your location took too long. Please check your connection and try again.'
              : 'Could not determine your location. Please try again.';
        reject(new Error(message));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}
