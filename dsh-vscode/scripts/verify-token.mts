const base = 'http://127.0.0.1:3080'
const token = process.argv[2] ?? ''

console.log('token length:', token.length)
const r = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
console.log('status:', r.status)
console.log('location:', r.headers.get('location'))
console.log('set-cookie:', r.headers.get('set-cookie'))
