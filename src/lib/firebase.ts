import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User, signOut } from "firebase/auth";
import firebaseConfig from "../../firebase-applet-config.json";

// Initialize Firebase App
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Configure Google OAuth Provider with requested Drive scopes
export const provider = new GoogleAuthProvider();
provider.addScope("https://www.googleapis.com/auth/drive");
provider.addScope("https://www.googleapis.com/auth/drive.readonly");
provider.addScope("https://www.googleapis.com/auth/drive.metadata.readonly");
provider.addScope("https://www.googleapis.com/auth/drive.file");

// In-memory token storage (Do NOT persist to localStorage/sessionStorage as per security guidelines)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

/**
 * Initializes and listens to the Firebase authentication state.
 */
export const initAuth = (
  onAuthSuccess: (user: User, token: string) => void,
  onAuthFailure: () => void
) => {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      if (cachedAccessToken) {
        onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        // If logged in but token is not cached (e.g. page reload), we need them to sign in again
        cachedAccessToken = null;
        onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      onAuthFailure();
    }
  });
};

/**
 * Performs popup-based Google Sign-In to obtain Firebase Auth user and Google Drive OAuth token.
 */
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Failed to extract Google OAuth access token from credential.");
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error("Firebase Sign-In Error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

/**
 * Retrieves the currently cached Google access token.
 */
export const getAccessToken = (): string | null => {
  return cachedAccessToken;
};

/**
 * Logs out the current user and clears the token cache.
 */
export const logoutUser = async (): Promise<void> => {
  await signOut(auth);
  cachedAccessToken = null;
};

