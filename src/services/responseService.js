function sendMockResponse(req, res, definition, finalBody) {
  const { statusCode, latency, responseHeaders = [], cookies = [] } = definition;

  responseHeaders.forEach(({ key, value }) => {
    if (key && value != null) res.set(key, String(value));
  });

  cookies.forEach(({ key, value = '', options = {} }) => {
    const cookieOpts = {
      httpOnly: options.httpOnly !== undefined ? options.httpOnly : true,
      path: options.path || '/',
      ...(options.domain && { domain: options.domain }),
      ...(options.secure !== undefined && { secure: options.secure }),
      ...(options.sameSite && { sameSite: options.sameSite }),
      ...(options.maxAge && { maxAge: Number(options.maxAge) }),
      ...(options.expires && { expires: new Date(options.expires) }),
    };
    res.cookie(key, value, cookieOpts);
  });

  const send = () => res.status(statusCode || 200).json(finalBody);
  if (latency && Number(latency) > 0) setTimeout(send, Number(latency));
  else send();
}

module.exports = sendMockResponse;