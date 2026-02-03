import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { twitchAuth } from '$lib/server/auth';

export const GET: RequestHandler = async () => {
	const status = twitchAuth.getStatus();
	return json(status);
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { action } = body;

	switch (action) {
		case 'startLogin': {
			try {
				const deviceCode = await twitchAuth.startDeviceFlow();

				// Start polling in the background
				twitchAuth.pollForToken(deviceCode).catch((error) => {
					console.error('[Auth API] Login failed:', error.message);
				});

				return json({
					success: true,
					userCode: deviceCode.user_code,
					verificationUri: deviceCode.verification_uri,
					expiresIn: deviceCode.expires_in
				});
			} catch (error) {
				return json(
					{ success: false, message: String(error) },
					{ status: 500 }
				);
			}
		}

		case 'cancelLogin': {
			twitchAuth.cancelPendingAuth();
			return json({ success: true, message: 'Login cancelled' });
		}

		case 'validate': {
			const isValid = await twitchAuth.validateToken();
			return json({ success: true, valid: isValid });
		}

		case 'logout': {
			twitchAuth.logout();
			return json({ success: true, message: 'Logged out' });
		}

		default:
			return json({ success: false, message: 'Unknown action' }, { status: 400 });
	}
};
