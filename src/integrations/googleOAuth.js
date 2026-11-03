import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_CLIENT_ID } from '../config/env.js';

const googleOAuthClient = new OAuth2Client(GOOGLE_CLIENT_ID);

export { googleOAuthClient };
