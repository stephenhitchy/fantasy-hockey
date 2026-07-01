import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { db } from './core/firebase';
import { doc, setDoc } from 'firebase/firestore';

console.log("Firebase connected!", db);

async function testFirestoreWrite() {
  await setDoc(doc(db, 'test', 'hello'), {
    message: 'Hello Firebase!',
    createdAt: new Date()
  });

  console.log('Test document written!');
}

testFirestoreWrite();

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
  
})



export class App {
  protected readonly title = signal('fantasy-hockey');
}
