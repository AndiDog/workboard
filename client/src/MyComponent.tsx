import { Component } from 'preact';
import { WorkboardClient, MarkReviewedCommand } from './generated/workboard';

export default class MyComponent extends Component {
  componentDidMount() {
    let client = new WorkboardClient('https://localhost:16667');
    let cmd = new MarkReviewedCommand();
    client.MarkReviewed(cmd, null, (error, res) => {
      console.log(
        `gRPC call done error=${error} res=${JSON.stringify(res.toObject())}`,
      );
    });
  }

  render() {
    return <h2>MyComponent</h2>;
  }
}
