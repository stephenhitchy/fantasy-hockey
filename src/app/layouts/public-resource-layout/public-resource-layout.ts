import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { Navbar } from '../../shared/navbar/navbar';

@Component({
  selector: 'app-public-resource-layout',
  standalone: true,
  imports: [Navbar, RouterLink, RouterOutlet],
  templateUrl: './public-resource-layout.html',
  styleUrl: './public-resource-layout.css',
})
export class PublicResourceLayout {}
