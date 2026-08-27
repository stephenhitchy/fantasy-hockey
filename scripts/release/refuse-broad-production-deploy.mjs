console.error('Broad production deployment is intentionally disabled for the season candidate.');
console.error('Use the exact release-specific Firebase --only selector from the current deployment guide.');
console.error('Do not deploy all Functions, Firestore Rules, indexes, and Hosting as one routine command.');
process.exitCode = 1;
