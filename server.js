import { port } from './src/config/env.js';
import './src/db/initDatabase.js';
import { app } from './src/app.js';


app.listen(port, () => {
  console.log(`Mimir Marking Server running on port ${port}`);
});
