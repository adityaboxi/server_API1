function patternToRegex(pattern) {
  const paramNames = [];
  const segments = pattern.split('/').filter(s => s !== '');
  const regexSegments = segments.map(seg => {
    if (seg.startsWith(':')) {
      paramNames.push(seg.slice(1));
      return '([^/]+)';
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return { regex: new RegExp('^/' + regexSegments.join('/') + '$'), paramNames };
}

function makeKey(projectId, version, method) {
  return `${projectId}:${version}:${method.toUpperCase()}`;
}

module.exports = { patternToRegex, makeKey };