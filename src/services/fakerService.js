const { faker } = require('@faker-js/faker');

function generateFakeResponse(responseBody) {
  if (typeof responseBody === 'string') {
    return responseBody.replace(/\{\{faker\.([^}]+)\}\}/g, (match, expr) => {
      try {
        const fn = new Function('faker', `return (faker.${expr});`);
        let result = fn(faker);
        if (typeof result === 'function') result = result();
        return result !== undefined ? result : match;
      } catch (err) {
        console.error(`[Faker] Error evaluating "faker.${expr}":`, err.message);
        return match;
      }
    });
  }
  if (Array.isArray(responseBody)) {
    return responseBody.map(item => generateFakeResponse(item));
  }
  if (typeof responseBody === 'object' && responseBody !== null) {
    const newObj = {};
    for (const [key, value] of Object.entries(responseBody)) {
      newObj[key] = generateFakeResponse(value);
    }
    return newObj;
  }
  return responseBody;
}

module.exports = generateFakeResponse;