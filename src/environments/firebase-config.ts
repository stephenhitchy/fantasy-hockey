// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
export const firebaseConfig = {
  apiKey: "AIzaSyA_84Xy_ieTc-R0oBd_yALcoGLUKt_USsY",
  authDomain: "nhl-fantasy-app-ab673.firebaseapp.com",
  projectId: "nhl-fantasy-app-ab673",
  storageBucket: "nhl-fantasy-app-ab673.firebasestorage.app",
  messagingSenderId: "721213878690",
  appId: "1:721213878690:web:1c5ba29562b332f84e02fb",
  measurementId: "G-063BT3987X"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);