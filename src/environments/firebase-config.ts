// Firebase web configuration for RinkRat Fantasy.
// Use the same-origin custom auth helper on the production domain, while
// retaining the Firebase default during localhost and legacy-host testing.
function resolveAuthDomain(): string {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase();

    if (host === 'rinkratfantasy.com' || host === 'www.rinkratfantasy.com') {
      return 'rinkratfantasy.com';
    }
  }

  return 'nhl-fantasy-app-ab673.firebaseapp.com';
}

export const firebaseConfig = {
  apiKey: "AIzaSyA_84Xy_ieTc-R0oBd_yALcoGLUKt_USsY",
  authDomain: resolveAuthDomain(),
  projectId: "nhl-fantasy-app-ab673",
  storageBucket: "nhl-fantasy-app-ab673.firebasestorage.app",
  messagingSenderId: "721213878690",
  appId: "1:721213878690:web:1c5ba29562b332f84e02fb",
  measurementId: "G-063BT3987X"
};
