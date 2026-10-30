/**
 * Hub-authored Notes stay short. The database and federation import paths may
 * retain larger bodies so ActivityPub objects are not rejected merely because
 * a remote server allows longer content.
 */
export const HUB_SOCIAL_POST_MAX_CHARACTERS = 500;

