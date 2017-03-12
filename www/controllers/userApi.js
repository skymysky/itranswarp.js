'use strict';

// user api

const
    _ = require('lodash'),
    oauth2 = require('oauth2-warp'),
    bluebird = require('bluebird'),
    api = require('../api'),
    db = require('../db'),
    auth = require('../auth'),
    helper = require('../helper'),
    logger = require('../logger'),
    config = require('../config'),
    constants = require('../constants'),
    User = db.User,
    AuthUser = db.AuthUser,
    LocalUser = db.LocalUser,
    nextId = db.nextId,
    SECURE = config.session.https;

var LOCAL_SIGNIN_EXPIRES_IN_MS = 1000 * config.session.expires;

var LOCK_TIMES = {
    d: 86400000,
    w: 604800000,
    m: 2592000000,
    y: 31536000000
};

// init oauth2 providers:

var oauth2_providers = {};

_.each(config.oauth2, (cfg, name) => {
    let provider = oauth2.createProvider(
        name,
        cfg.app_key,
        cfg.app_secret,
        cfg.redirect_uri
    );
    provider.getAuthentication = bluebird.promisify(provider.getAuthentication, { context: provider });
    oauth2_providers[name] = provider;
    logger.info('Init OAuth2: ' + name + ', redirect_uri = ' + provider.redirect_uri);
});

async function getUsers(page) {
    page.total = await User.count();
    if (page.isEmpty) {
        return [];
    }
    var users = await User.findAll({
        offset: page.offset,
        limit: page.limit,
        order: 'created_at DESC'
    });
    return users;
}

/**
 * Get user by email. Return null if not found.
 * 
 * @param {string} email 
 */
async function getUserByEmail(email) {
    return await User.findOne({
        where: {
            'email': email
        }
    });
}

async function getUser(id) {
    let user = await User.findById(id);
    if (user === null) {
        throw api.notFound('User');
    }
    return user;
}

async function bindUsers(entities, propName) {
    var i, entity, u, prop = propName || 'user_id';
    for (i=0; i<entities.length; i++) {
        entity = entities[i];
        entity.user = await User.findById({
            select: ['id', 'name', 'image_url'],
            where: 'id=?',
            params: [entity[prop]]
        });
    }
}

async function processOAuthAuthentication(provider_name, authentication) {
    let
        auth_id = provider_name + ':' + authentication.auth_id,
        user,
        user_id,
        auth_user = await AuthUser.findById({
            where: {
                auth_id: auth_id
            }
        });
    if (auth_user === null) {
        // first time to signin:
        user_id = nextId();
        user = {
            id: user_id,
            email: user_id + '@' + provider_name,
            name: authentication.name,
            image_url: authentication.image_url || '/static/img/user.png'
        };
        auth_user = {
            user_id: user_id,
            auth_provider: provider_name,
            auth_id: auth_id,
            auth_token: authentication.access_token,
            expires_at: Date.now() + 1000 * Math.min(604800, authentication.expires_in)
        };
        await AuthUser.create(auth_user);
        await User.create(user);
        return {
            user: user,
            auth_user: auth_user
        };
    }
    // not first time to signin:
    auth_user.auth_token = authentication.access_token;
    auth_user.expires_at = Date.now() + 1000 * Math.min(604800, authentication.expires_in);
    await auth_user.save();
    // find user:
    user = await User.findById(auth_user.user_id);
    if (user === null) {
        logger.warn('Logic error: user not found!');
        user_id = auth_user.user_id;
        user = {
            id: user_id,
            email: user_id + '@' + provider_name,
            name: authentication.name,
            image_url: authentication.image_url || '/static/img/user.png'
        };
        await User.create(user);
    }
    return {
        user: user,
        auth_user: auth_user
    };
}

function _getReferer(request) {
    let url = request.get('referer') || '/';
    if (url.indexOf('/auth/') >= 0 || url.indexOf('/manage/') >= 0) {
        url = '/';
    }
    return url;
}

module.exports = {

    getUser: getUser,

    getUsers: getUsers,

    bindUsers: bindUsers,

    'GET /api/users/:id': async (ctx, next) => {
        ctx.checkPermission(constants.role.EDITOR);
        let
            id = ctx.params.id,
            user = await getUser(id);
        ctx.rest(user);
    },

    'GET /api/users': async (ctx, next) => {
        ctx.checkPermission(constants.role.EDITOR);
        var
            page = helper.getPage(ctx.request),
            users = await getUsers(page);
        ctx.rest({
            page: page,
            users: users
        });
    },

    'POST /api/authenticate': async (ctx, next) => {
        /**
         * Authenticate user by email and password, for local user only.
         * 
         * @param email: Email address, in lower case.
         * @param passwd: The password, 40-chars SHA1 string, in lower case.
         */
        ctx.validate('authenticate');
        let
            localuser,
            data = ctx.request.body,
            email = data.email,
            passwd = data.passwd,
            user = await getUserByEmail(email);
        if (user === null) {
            throw api.authFailed('email', 'Email not found.');
        }
        if (user.locked_until > Date.now()) {
            throw api.authFailed('locked', 'User is locked.');
        }
        localuser = await LocalUser.findOne({
            where: {
                user_id: user.id
            }
        });
        if (localuser === null) {
            throw api.authFailed('passwd', 'Cannot signin local.')
        }
        // check password:
        if (!auth.verifyPassword(localuser.id, passwd, localuser.passwd)) {
            throw api.authFailed('passwd', 'Bad password.');
        }
        // make session cookie:
        let
            expires = Date.now() + LOCAL_SIGNIN_EXPIRES_IN_MS,
            cookieStr = auth.makeSessionCookie(constants.signin.LOCAL, localuser.id, localuser.passwd, expires);
        ctx.cookies.set(config.session.cookie, cookieStr, {
            path: '/',
            httpOnly: true,
            secure: SECURE,
            expires: new Date(expires)
        });
        logger.info('set session cookie for user: ' + user.email);
        ctx.rest(user);
    },

    'GET /auth/signout': async (ctx, next) => {
        ctx.cookies.set(config.session.cookie, 'deleted', {
            path: '/',
            httpOnly: true,
            secure: SECURE,
            expires: new Date(0)
        });
        logger.info('Signout, goodbye!');
        ctx.response.redirect(_getReferer(ctx.request));
    },

    // start oauth:
    'GET /auth/from/:name': async (ctx, next) => {
        let
            name = ctx.params.name,
            provider = oauth2_providers[name],
            redirect_uri,
            jscallback = ctx.request.query.jscallback;
        if (! provider) {
            ctx.response.status = 404;
            ctx.response.body = 'Invalid URL';
            return;
        }
        redirect_uri = provider.redirect_uri;
        if (redirect_uri.indexOf('http://') !== 0 || redirect_uri.indexOf('https://') !== 0) {
            redirect_uri = (SECURE ? 'https://' : 'http://') + ctx.request.host + '/auth/callback/' + name;
        }
        if (jscallback) {
            redirect_uri = redirect_uri + '?jscallback=' + jscallback;
        }
        else {
            redirect_uri = redirect_uri + '?redirect=' + encodeURIComponent(_getReferer(ctx.request));
        }
        ctx.response.redirect(provider.getAuthenticateURL({
            redirect_uri: redirect_uri
        }));
    },

    // callback from oauth provider:
    'GET /auth/callback/:name': async (ctx, next) => {
        let
            provider = oauth2_providers[name],
            code = ctx.request.query.code,
            jscallback = ctx.request.query.jscallback || '',
            authentication, r, auth_user, user, cookieStr;
        if (! provider) {
            ctx.response.status = 404;
            ctx.response.body = 'Invalid URL';
            return;
        }
        if (!code) {
            logger.warn('OAuth2 callback error: code is not found.');
            ctx.response.body = '<html><body>Invalid code.</body></html>';
            return;
        }
        try {
            authentication = await provider.getAuthentication({
                code: code
            });
        }
        catch (e) {
            logger.warn('OAuth2 callback error: get authentication failed.');
            ctx.response.body = '<html><body>Authenticate failed.</body></html>';
            return;
        }
        logger.info('OAuth2 callback ok: ' + JSON.stringify(authentication));
        r = await processOAuthAuthentication(name, authentication);
        auth_user = r.auth_user;
        user = r.user;
        if (user.locked_until > Date.now()) {
            logger.warn('User is locked: ' + user.email);
            ctx.response.body = '<html><body>User is locked.</body></html>';
            return;
        }
        // make session cookie:
        cookieStr = auth.makeSessionCookie(name, auth_user.id, auth_user.auth_token, auth_user.expires_at);
        ctx.response.cookies.set(config.session.cookie, cookieStr, {
            path: '/',
            httpOnly: true,
            secure: SECURE,
            expires: new Date(auth_user.expires_at)
        });
        logger.info('set session cookie for user: ' + user.email);
        if (jscallback) {
            ctx.response.body = '<html><body><script> window.opener.'
                      + jscallback
                      + '(null,' + JSON.stringify({
                          id: user.id,
                          name: user.name,
                          image_url: user.image_url
                      }) + ');self.close(); </script></body></html>';
        }
        else {
            ctx.response.redirect(ctx.request.query.redirect || '/');
        }
    },

    'POST /api/users/:id/lock': async (ctx, next) => {
        ctx.checkPermission(constants.role.ADMIN);
        ctx.validate('lockUser');
        let
            id = ctx.params.id,
            user = await getUser(id),
            locked_until = ctx.request.body.locked_until;
        if (user.role <= constants.role.ADMIN) {
            throw api.notAllowed('Cannot lock admin user.');
        }
        await user.update({
            'locked_until': lockTime
        });
        ct.rest({
            locked_until: locked_until
        });
    }
};
